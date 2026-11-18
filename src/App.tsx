import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, type Json, type Point, type Scenario } from "./api";
import { createScene, rankColour, type LayerId, type Pick, type Scene, type ZoneType } from "./viewer";
import { STEP_MS } from "./water";
import { MODES, useSim, type Mode } from "./Sims";
import { useSection } from "./Section";

interface Selection {
  point: Point;
  gmlId: string | null;
  building: Json | null;
  exposure: Json | null;
  note?: string;
}

const LAYERS: { id: LayerId; label: string; hint: string }[] = [
  { id: "buildings", label: "Buildings", hint: "PLATEAU 3D model" },
  { id: "roads", label: "Roads", hint: "Road surfaces; exposed in vermilion" },
  { id: "hazards", label: "Flood-risk zones", hint: "PLATEAU river flooding, by depth rank" },
  { id: "flood", label: "Flood water", hint: "GSI breach scenario over time" },
];

const na = (v: unknown, unit = "") => (v === null || v === undefined || v === "" ? "Not available" : `${v}${unit}`);
const num = (v: number | null | undefined, digits = 0) =>
  v === null || v === undefined ? "Not available" : v.toLocaleString("en", { maximumFractionDigits: digits });

function elapsed(minutes: number) {
  const d = Math.floor(minutes / 1440), h = Math.floor((minutes % 1440) / 60), m = Math.round(minutes % 60);
  return `${d ? `${d} d ` : ""}${h} h ${String(m).padStart(2, "0")} min`;
}

/** English reading of a source depth-rank label such as "0.5m以上3m未満". The original stays visible. */
function rankGloss(label: string | null) {
  const m = label?.match(/^(?:([\d.]+)m以上)?(?:([\d.]+)m未満)?$/);
  if (!m || (!m[1] && !m[2])) return "";
  return m[1] && m[2] ? `${m[1]} m to under ${m[2]} m` : m[1] ? `${m[1]} m or more` : `under ${m[2]} m`;
}

export default function App() {
  const container = useRef<HTMLDivElement>(null);
  const scene = useRef<Scene | null>(null);
  const [meta, setMeta] = useState<Json>(null);
  const [dash, setDash] = useState<Json>(null);
  const [error, setError] = useState<string | null>(null);
  const [layers, setLayers] = useState<Record<LayerId, boolean>>({ buildings: true, roads: false, hazards: false, flood: true });
  const [sel, setSel] = useState<Selection | null>(null);
  const [found, setFound] = useState<{ list: Scenario[]; message: string | null } | null>(null);
  const [searching, setSearching] = useState(false);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [hydro, setHydro] = useState<Json>(null);
  const [showSources, setShowSources] = useState(false);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<Mode>("flood");

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  async function select(p: Pick) {
    if (!p.point && !p.gmlId) return;
    try {
      // Prefer the GML ID from the 3D Tiles feature; fall back to a footprint lookup at the clicked position.
      let building: Json = null;
      if (p.gmlId) building = await api(`/buildings/${p.gmlId}`).catch(() => null);
      else if (p.isBuilding && p.point) building = (await api("/buildings", { ...p.point }))[0] ?? null;
      const point = building ? { lon: building.lon, lat: building.lat } : p.point;
      if (!point) return;
      setSel({
        point,
        gmlId: building?.gml_id ?? p.gmlId,
        building,
        exposure: building ? await api(`/buildings/${building.gml_id}/exposure`) : null,
        note: p.isBuilding && !building
          ? "This building is outside the ingested pilot area, so no attribute record is available."
          : undefined,
      });
      setFound(null);
      scene.current?.highlight(building?.gml_id ?? p.gmlId);
      scene.current?.mark(building ? null : point);
    } catch (e) {
      fail(e);
    }
  }
  const selectRef = useRef(select);
  selectRef.current = select;

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const m = await api("/city/metadata");
        setMeta(m);
        api("/dashboard/impact").then(setDash, fail);
        const s = await createScene(container.current!, m, (p) => selectRef.current(p));
        if (dead) s.destroy();
        else {
          scene.current = s;
          setReady(true);
        }
      } catch (e) {
        fail(e);
      }
    })();
    return () => {
      dead = true;
      scene.current?.destroy();
      scene.current = null;
    };
  }, []);

  // GSI raster follows the selected scenario and published time step.
  const minutes = scenario?.time_steps[step];
  const stages = scenario?.stages; // storm-surge and earthquake modes
  const quake = scenario?.zoneType === "earthquake_shaking";
  useEffect(() => {
    const s = scene.current;
    if (!s) return;
    const breach = scenario?.breach_lon != null && scenario.breach_lat != null
      ? { lon: scenario.breach_lon, lat: scenario.breach_lat } : undefined;
    if (stages) s.setZones(scenario.zoneType!, Number(stages[step].rank));
    else s.setFlood(scenario?.tile_url_template ?? null, minutes, breach);
    s.markBreach(breach ?? null, `Levee breach · ${scenario?.river_name} ${scenario?.breach_location}`);
  }, [scenario, minutes]);

  useEffect(() => {
    if (!playing || !scenario) return;
    const last = scenario.time_steps.length - 1;
    const t = setInterval(() => setStep((s) => {
      if (s >= last - 1) setPlaying(false);
      return Math.min(s + 1, last);
    }), STEP_MS);
    return () => clearInterval(t);
  }, [playing, scenario]);

  // Point hydrograph for the current selection under the active scenario (one cached request).
  useEffect(() => {
    setHydro(null);
    if (!scenario || !sel || scenario.stages) return;
    let stale = false;
    api(`/flood/scenarios/${scenario.id}/hydrograph`, { ...sel.point }).then((h) => !stale && setHydro(h), fail);
    return () => {
      stale = true;
    };
  }, [scenario, sel]);

  function toggle(id: LayerId) {
    const on = !layers[id];
    setLayers({ ...layers, [id]: on });
    scene.current?.setLayer(id, on).catch(fail);
  }

  async function findScenarios() {
    if (!sel) return;
    setSearching(true);
    try {
      const r = await api("/flood/scenarios", { ...sel.point });
      setFound({ list: r.scenarios, message: r.message });
    } catch (e) {
      fail(e);
    } finally {
      setSearching(false);
    }
  }

  /** One click: find the breach scenarios for the selection (or the pilot point), start the worst one and play it. */
  async function runSimulation() {
    if (scenario) {
      setScenario(null);
      setPlaying(false);
      return;
    }
    if (!meta) return;
    setSearching(true);
    try {
      const r = await api("/flood/scenarios", { ...(sel?.point ?? meta.pilot) });
      const list: Scenario[] = r.scenarios;
      setFound({ list, message: r.message });
      // GSI flags the scenario that gives the greatest depth at this point; fall back to the first with map tiles.
      const pick = list.find((s) => s.flags?.isDepthMax && s.tile_url_template) ?? list.find((s) => s.tile_url_template);
      if (!pick) return setError(r.message ?? "GSI publishes no breach scenario with map tiles for this point.");
      if (!layers.flood) toggle("flood");
      setScenario(pick);
      setStep(0);
      setPlaying(true);
    } catch (e) {
      fail(e);
    } finally {
      setSearching(false);
    }
  }

  /** Storm surge and earthquake shaking are published as final zones with no timing, so these fill highest rank first. */
  async function runZones(zoneType: ZoneType) {
    if (!scene.current) return;
    try {
      const found = await scene.current.loadZones(zoneType);
      if (!found.length) return setError("No published zones of this hazard in the pilot area. Run its ingestion job first.");
      if (!layers.flood) toggle("flood");
      setScenario({ id: zoneType, breach_name: zoneType, breach_location: "", river_name: "", rainfall_scale: 0,
                    rainfall_label: "", time_steps: found.map((_, i) => i + 1), tile_url_template: null, stages: found, zoneType });
      setStep(0);
      setPlaying(true);
    } catch (e) {
      fail(e);
    }
  }

  function pickScenario(id: string) {
    setScenario(found?.list.find((s) => s.id === id) ?? null);
    setStep(0);
    setPlaying(false);
  }

  const sim = useSim(mode, scene, ready, scenario, stages ? undefined : minutes, sel?.building?.gml_id ?? null, fail);
  const section = useSection(mode === "section", scene, ready, sel?.point ?? meta?.pilot, scenario, stages ? undefined : minutes,
                             sel?.building?.gml_id ?? null, (id) => select({ isBuilding: true, gmlId: id, point: null }), fail);
  const depthNow = hydro?.series?.find((p: Json) => p.minutes === minutes)?.depth_m;
  const b = sel?.building;
  const stat = dash?.static;

  const glass = "pointer-events-auto border border-line bg-bg/80 backdrop-blur-xl";
  const link = "text-dim underline decoration-line underline-offset-4 transition-colors hover:text-ink";

  return (
    <div className="relative h-full overflow-hidden text-[13px] leading-5 text-ink">
      <div ref={container} className={`absolute inset-0 ${quake && playing ? "shake" : ""}`} />
      {/* Scrims keep type legible over the map without boxing it in. */}
      <div className="pointer-events-none absolute inset-y-0 left-0 w-[30rem] bg-gradient-to-r from-bg via-bg/70 to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-bg/80 to-transparent" />

      {/* Loading curtain: the 3D scene takes a few seconds to arrive. */}
      <div className={`absolute inset-0 z-20 grid place-items-center bg-bg transition-opacity duration-1000 ease-out ${ready ? "pointer-events-none opacity-0" : ""}`}>
        <div className="text-center">
          <div className="text-[clamp(2.5rem,7vw,6rem)] font-medium leading-none tracking-[-0.05em]">Mirror City</div>
          <div className="mt-4 text-dim">{error ? error : "Loading Sumida Ward"}</div>
        </div>
      </div>

      <header className="pointer-events-none absolute inset-x-0 top-0 flex items-baseline gap-6 px-8 pt-6">
        <div className="text-[15px] font-semibold tracking-[-0.02em]">Mirror City</div>
        <div className="text-dim">Sumida Ward, Tokyo{meta && ` — PLATEAU ${meta.dataset.year}`}</div>
        <button className={`pointer-events-auto ml-auto ${link}`} onClick={() => setShowSources(!showSources)}>Sources</button>
      </header>

      {showSources && meta && (
        <div className={`${glass} rise absolute right-8 top-16 z-10 w-80 p-5 text-xs`}>
          {meta.sources.map((s: Json) => (
            <div key={s.id} className="mb-3">
              <a className="text-ink underline decoration-line underline-offset-4" href={s.source_url} target="_blank" rel="noreferrer">
                {s.dataset_name} {s.dataset_year ?? ""}
              </a>
              <div className="text-dim">
                {s.provider} · <a className="underline" href={s.license_url} target="_blank" rel="noreferrer">terms</a>
              </div>
            </div>
          ))}
          <p className="text-dim">
            Base map: GSI Tiles. Terrain: PLATEAU. Built with CesiumJS. Not a substitute for official
            disaster-management information.
          </p>
        </div>
      )}

      {/* Left column: layers, then the headline figures */}
      <div className="pointer-events-none absolute bottom-8 left-8 top-24 flex w-72 flex-col justify-between">
        <div className="pointer-events-auto space-y-3">
          <div className="mb-4 flex gap-4 border-b border-line pb-2" role="tablist" aria-label="Simulator">
            {MODES.map((m) => (
              <button key={m.id} role="tab" aria-selected={mode === m.id} onClick={() => setMode(m.id)}
                      className={`transition-colors ${mode === m.id ? "text-ink" : "text-dim hover:text-ink"}`}>
                {m.label}
              </button>
            ))}
          </div>
          <button onClick={runSimulation} disabled={searching || !ready}
                  className={`mb-3 flex w-full items-center justify-between px-4 py-3 text-[15px] font-medium transition-opacity duration-200 hover:opacity-85 disabled:opacity-50 ${scenario ? "border border-line text-ink" : "bg-accent text-bg"}`}>
            {scenario ? "Stop simulation" : searching ? "Asking GSI…" : "Run river flood"}
            <span aria-hidden className="text-xs">{scenario ? "■" : "▶"}</span>
          </button>
          {!scenario && mode !== "section" && ([["storm_surge", "Run storm surge"], ["earthquake_shaking", "Run earthquake"]] as const).map(([type, label]) => (
            <button key={type} onClick={() => runZones(type)} disabled={!ready}
                    className="-mt-3 mb-3 flex w-full items-center justify-between border border-line px-4 py-3 text-[15px] font-medium transition-colors duration-200 hover:border-ink disabled:opacity-50">
              {label}
              <span aria-hidden className="text-xs">▶</span>
            </button>
          ))}
          {LAYERS.map((l) => (
            <button key={l.id} role="switch" aria-checked={layers[l.id]} onClick={() => toggle(l.id)} className="group flex w-full items-center gap-3 text-left">
              <span className={`relative h-4 w-7 shrink-0 rounded-full transition-colors duration-200 ${layers[l.id] ? "bg-ink" : "bg-line"}`}>
                <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-bg transition-transform duration-200 ${layers[l.id] ? "translate-x-3.5" : "translate-x-0.5"}`} />
              </span>
              <span className={`transition-colors ${layers[l.id] ? "text-ink" : "text-dim group-hover:text-ink"}`}>{l.label}</span>
            </button>
          ))}
          {layers.hazards && (
            <div className="rise flex items-center gap-3 pt-1 text-xs text-dim">
              {[["1", "under 0.5 m"], ["2", "0.5–3 m"], ["3", "3–5 m"]].map(([r, t]) => (
                <span key={r} className="flex items-center gap-1.5">
                  <i className="h-2 w-2 rounded-full" style={{ background: rankColour(r) }} />
                  {t}
                </span>
              ))}
            </div>
          )}
          {layers.roads && <div className="rise text-xs text-dim">Roads in amber cross a mapped flood-risk zone.</div>}
        </div>

        {mode !== "flood" && sim.headline}
        {section.panel}
        {mode === "flood" && stat && (
          <div className="rise pointer-events-auto">
            <div className="font-medium leading-[0.85] tracking-[-0.06em] text-[clamp(4rem,8vw,7rem)]">
              {num(stat.buildings.exposed_percentage, 1)}
              <span className="text-[0.45em] tracking-[-0.02em] text-dim">%</span>
            </div>
            <p className="mt-3 max-w-60 text-[15px] leading-snug">of buildings here stand in a mapped river-flood zone.</p>
            <p className="mt-1 text-xs tabular-nums text-dim">
              {num(stat.buildings.exposed_buildings)} of {num(stat.buildings.total_buildings)} buildings ·{" "}
              {num(stat.roads.exposure_percentage, 0)}% of road length ({num(stat.roads.exposed_road_length_m / 1000, 0)} of{" "}
              {num(stat.roads.total_road_length_m / 1000, 0)} km, estimated)
            </p>
            <p className="mt-2 max-w-64 text-xs text-dim">
              Static PLATEAU risk at maximum assumed rainfall, pilot area only. A road crossing a zone is not necessarily closed.
            </p>
          </div>
        )}
      </div>

      {/* Inspector */}
      {sel && (
        <aside key={sel.gmlId ?? `${sel.point.lon},${sel.point.lat}`} className={`${glass} rise absolute bottom-8 right-8 top-20 flex w-[21rem] flex-col overflow-y-auto`}>
          <div className="p-6 pb-5">
            <div className="text-xs text-dim">{b || sel.gmlId ? "Building" : "Point"}</div>
            <h2 className="mt-1 text-2xl font-medium leading-tight tracking-[-0.03em]">{b ? na(b.usage) : sel.gmlId ? "Outside pilot area" : "Selected point"}</h2>
            <p className="mt-1 text-xs tabular-nums text-dim">{sel.point.lat.toFixed(5)}, {sel.point.lon.toFixed(5)}</p>
            {sel.note && <p className="mt-3 text-xs text-accent">{sel.note}</p>}
          </div>

          {b && (
            <Block title="Attributes">
              <Row k="Height" v={na(b.height, " m")} />
              <Row k="Floors above ground" v={na(b.floors)} />
              <Row k="Built" v={na(b.construction_year)} />
              <Row k="Structure" v={na(b.structure_type)} />
              <Row k="Footprint" v={`${num(b.footprint_area_m2, 0)} m²`} />
              <p className="mt-3 break-all font-mono text-[11px] leading-4 text-dim">{b.gml_id}</p>
              <p className="mt-1 text-xs text-dim">{b.source.dataset_name} {b.source.dataset_year}, {b.source.provider}</p>
            </Block>
          )}

          {sel.exposure && (
            <Block title="Static flood risk">
              {sel.exposure.summary.length === 0 && <p>The footprint is outside every mapped river-flood zone.</p>}
              {sel.exposure.summary.map((s: Json) => (
                <div key={s.hazard_name} className="mb-3 last:mb-0">
                  <div className="flex items-baseline gap-2">
                    <i className="h-2 w-2 shrink-0 self-center rounded-full" style={{ background: rankColour(s.hazard_rank) }} />
                    <span className="text-[15px]">{rankGloss(s.hazard_rank_label) || s.hazard_rank_label}</span>
                    <span className="ml-auto text-xs tabular-nums text-dim">{num(s.overlap_percentage, 0)}% of footprint</span>
                  </div>
                  <p className="pl-4 text-xs text-dim">{s.hazard_name} · rank {s.hazard_rank}</p>
                </div>
              ))}
              <p className="mt-3 text-xs text-dim">Depth ranks are the source's categories, not measured depths.</p>
            </Block>
          )}

          {mode !== "flood" && sim.inspector && <Block title={sim.title}>{sim.inspector}</Block>}
          {section.inspector && <Block title="In this section">{section.inspector}</Block>}

          <Block title="Breach scenario">
            {found && found.list.length > 0 ? (
              <select className="w-full border border-line bg-transparent px-2 py-2 text-ink outline-none focus-visible:border-ink" aria-label="Breach scenario"
                      value={found.list.some((s) => s.id === scenario?.id) ? scenario!.id : ""} onChange={(e) => pickScenario(e.target.value)}>
                <option value="">Choose from {found.list.length} scenarios</option>
                {found.list.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.river_name} {s.breach_location} · {s.rainfall_label.slice(0, 2)} · {s.breach_name}
                  </option>
                ))}
              </select>
            ) : (
              <button className="w-full bg-ink px-3 py-2.5 font-medium text-bg transition-opacity duration-200 hover:opacity-85 disabled:opacity-50"
                      disabled={searching} onClick={findScenarios}>
                {searching ? "Asking GSI…" : "Find breach scenarios here"}
              </button>
            )}
            {found?.message && <p className="mt-2 text-xs text-accent">{found.message}</p>}
            {scenario && !stages && (
              <div className="mt-3">
                <Row k="River" v={na(scenario.river_name)} />
                <Row k="Breach" v={na(scenario.breach_location)} />
                <Row k="Rainfall" v={scenario.rainfall_label.replace(/^L\d — /, "")} />
                <button className={`mt-2 text-xs ${link}`} onClick={() => pickScenario("")}>Clear scenario</button>
              </div>
            )}
            <p className="mt-3 text-xs text-dim">Hypothetical breach scenarios published by GSI. Not live conditions.</p>
          </Block>

          {scenario && !stages && (
            <Block title="Depth at this point">
              {!hydro && <p className="text-dim">Loading…</p>}
              {hydro && !hydro.covered && <p className="text-xs text-accent">{hydro.message} That does not prove the point stays dry.</p>}
              {hydro?.covered && (
                <>
                  <div className="flex items-baseline gap-2">
                    <span className="text-4xl font-medium tracking-[-0.04em] tabular-nums">{depthNow === undefined ? "—" : depthNow.toFixed(2)}</span>
                    <span className="text-dim">m at {elapsed(minutes!)}</span>
                  </div>
                  <Hydrograph series={hydro.series} current={minutes!} />
                  <Row k="Water arrives" v={hydro.arrival_minutes == null ? "Not available" : elapsed(hydro.arrival_minutes)} />
                  <Row k="Peak depth" v={na(hydro.max_depth_m, " m")} />
                  <Row k="Peak reached" v={hydro.time_of_max_minutes == null ? "Not available" : elapsed(hydro.time_of_max_minutes)} />
                  <p className="mt-3 text-xs text-dim">
                    One point sample{b && " at the building's representative point"}, not a whole-building depth. GSI Inundation Navi, {scenario.breach_name}.
                  </p>
                </>
              )}
            </Block>
          )}
        </aside>
      )}

      {section.drawing && (
        <div className={`pointer-events-none absolute inset-x-0 flex justify-center px-4 ${scenario ? "bottom-48" : "bottom-8"}`}>
          <div className={`${glass} rise w-[min(44rem,100%)] px-4 py-3`}>{section.drawing}</div>
        </div>
      )}

      {/* Timeline, or the opening hint */}
      <div className="pointer-events-none absolute inset-x-0 bottom-8 flex justify-center px-4">
        {scenario ? (
          <div className={`${glass} rise w-[min(40rem,100%)] px-6 py-4`}>
            <div className="flex items-baseline gap-3">
              <span className="text-2xl font-medium tracking-[-0.03em] tabular-nums">{stages ? `Stage ${step + 1}` : elapsed(minutes!)}</span>
              <span className="truncate text-dim">
                {quake
                  ? `earthquake shaking · areas at intensity ${stages![step].label} and stronger`
                  : stages
                  ? `storm surge · areas with a final depth of ${rankGloss(stages[step].label) || stages[step].label} and deeper`
                  : `after the breach at ${scenario.river_name} ${scenario.breach_location}`}
              </span>
              <span className="ml-auto text-xs tabular-nums text-dim">{step + 1} / {scenario.time_steps.length}</span>
            </div>
            <div className="mt-3 flex items-center gap-4">
              <button className={link} onClick={() => setPlaying(!playing)}>{playing ? "Pause" : "Play"}</button>
              <button aria-label="Previous time step" className={link} onClick={() => setStep(Math.max(0, step - 1))}>Back</button>
              <button aria-label="Next time step" className={link} onClick={() => setStep(Math.min(scenario.time_steps.length - 1, step + 1))}>Next</button>
              <input type="range" className="flex-1" aria-label="Scenario time step" min={0}
                     max={scenario.time_steps.length - 1} value={step} onChange={(e) => setStep(Number(e.target.value))} />
            </div>
            <p className="mt-2 text-xs text-dim">
              {quake
                ? "Shaking is NIED J-SHIS's long-term hazard map (2024): the JMA intensity with a 3% chance of being exceeded in 30 years, per 250 m cell. It is not one earthquake or a forecast: the order (strongest first), motion and screen shake are illustrative."
                : stages
                ? "Extent and depth rank are PLATEAU's storm-surge zones. No timing is published: the fill order (deepest first) and motion are illustrative."
                : "Water extent is GSI's published data at each time step. The spread outwards from the breach between steps is a visual blend, not simulated flow."}
            </p>
            {!stages && !scenario.tile_url_template && <p className="mt-2 text-xs text-accent">GSI publishes no map tiles for this scenario class.</p>}
          </div>
        ) : (
          !sel && meta && mode !== "section" && <div className="rise text-dim">Click a building to inspect it, or the ground to pick a point.</div>
        )}
      </div>

      <div className={`${glass} absolute bottom-8 flex flex-col transition-[right] duration-500 ${sel ? "right-[24.5rem]" : "right-8"}`}>
        <button aria-label="Zoom in" title="Zoom in" className="h-9 w-9 text-lg text-dim transition-colors hover:text-ink" onClick={() => scene.current?.zoom(1)}>+</button>
        <button aria-label="Zoom out" title="Zoom out" className="h-9 w-9 border-y border-line text-lg text-dim transition-colors hover:text-ink" onClick={() => scene.current?.zoom(-1)}>−</button>
        <button aria-label="Reset view" title="Reset view" className="h-9 w-9 text-[10px] text-dim transition-colors hover:text-ink" onClick={() => scene.current?.home()}>RESET</button>
      </div>

      {error && meta && (
        <div className={`${glass} rise absolute left-1/2 top-16 z-10 flex -translate-x-1/2 items-center gap-4 px-4 py-2 text-xs text-accent`} role="alert">
          {error}
          <button className={link} onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}
    </div>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-line px-6 py-5">
      <h3 className="mb-3 text-xs text-dim">{title}</h3>
      {children}
    </section>
  );
}

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex justify-between gap-3 py-1">
      <span className="text-dim">{k}</span>
      <span className="text-right tabular-nums">{v}</span>
    </div>
  );
}

/** Depth over the scenario's published time steps. Steps are evenly spaced on x; they are not uniform in time. */
function Hydrograph({ series, current }: { series: { minutes: number; depth_m: number }[]; current: number }) {
  const W = 288, H = 80, top = 4;
  const max = Math.max(...series.map((p) => p.depth_m), 0.01);
  const x = (i: number) => (i / Math.max(series.length - 1, 1)) * W;
  const y = (d: number) => top + (1 - d / max) * (H - top);
  const at = series.findIndex((p) => p.minutes === current);
  const line = series.map((p, i) => `${x(i)},${y(p.depth_m)}`).join(" ");
  return (
    <figure className="my-4">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full overflow-visible border-b border-line" role="img" aria-label="Flood depth over time at this point">
        <polygon points={`0,${H} ${line} ${W},${H}`} fill="currentColor" opacity="0.1" />
        <polyline points={line} fill="none" stroke="currentColor" strokeWidth="1.25" />
        {at >= 0 && (
          <>
            <line x1={x(at)} x2={x(at)} y1={0} y2={H} stroke="var(--color-accent)" strokeWidth="1" />
            <circle cx={x(at)} cy={y(series[at].depth_m)} r="3" fill="var(--color-accent)" />
          </>
        )}
      </svg>
      <figcaption className="mt-1.5 flex justify-between text-[11px] tabular-nums text-dim">
        <span>{elapsed(series[0].minutes)} · steps not to scale</span>
        <span>{elapsed(series[series.length - 1].minutes)}</span>
      </figcaption>
    </figure>
  );
}
