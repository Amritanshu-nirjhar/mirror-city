// Residences: explore real Sumida as a property showcase. Buildings, land prices, amenities and
// walking times are real; open data has no listings, so prices are labelled estimates.
import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Json } from "./api";
import { depthAt, loadFloodField, NEVER, type FloodField } from "./floodSim";
import { createEstate, RADIUS, type Estate, type Light, type RenderStatus, type Shot } from "./estateScene";

// Assumptions behind the estimate (calibration knobs).
const BUILD_COST = 450_000; // yen per m² of floor built
const NET_TO_GROSS = 0.8; // share of a building's floor area that is inside homes
// MLIT's recommended floor area for city housing (都市居住型誘導居住面積): 2, 3 and 4 people.
const BEDROOM_M2: Record<number, number> = { 1: 55, 2: 75, 3: 95 };

const HERO = { lon: 139.8187, lat: 35.7166 }, TREE = { lon: 139.8107, lat: 35.7101 };
const HOME: Shot = { ...HERO, z: 40, heading: 215, pitch: -27, range: 880 };
const GALLERY: { name: string; shot: Shot; light?: Light }[] = [
  { name: "Bird's-eye", shot: { ...HERO, z: 0, heading: 0, pitch: -72, range: 1500 } },
  { name: "Elevated", shot: { ...HERO, z: 40, heading: 215, pitch: -30, range: 600 } },
  { name: "Close-up", shot: { ...HERO, z: 65, heading: 150, pitch: -10, range: 210 } },
  { name: "Low angle", shot: { ...HERO, z: 75, heading: 245, pitch: 16, range: 190 } },
  { name: "Wide city", shot: { lon: 139.81, lat: 35.712, z: 90, heading: 245, pitch: -9, range: 3300 } },
  { name: "Sunset", shot: { ...TREE, z: 210, heading: 240, pitch: -4, range: 1900 }, light: "sunset" },
];
const SIGHTS: { name: string; note: string; shot: Shot }[] = [
  { name: "Tokyo Skytree", note: "634 m broadcast tower at Oshiage, the tallest structure in Japan.", shot: { ...TREE, z: 260, heading: 40, pitch: -8, range: 1050 } },
  { name: "Sumida River", note: "The ward's western edge, lined by Sumida Park and crossed by historic bridges.", shot: { lon: 139.8035, lat: 35.7155, z: 5, heading: 200, pitch: -22, range: 900 } },
  { name: "Mukojima Hyakkaen", note: "A garden laid out in the Edo period, north of Hikifune.", shot: { lon: 139.815542, lat: 35.724251, z: 0, heading: 20, pitch: -38, range: 420 } },
  { name: "Kyojima", note: "Narrow lanes and low wooden houses beneath the towers.", shot: { lon: 139.8205, lat: 35.7155, z: 5, heading: 300, pitch: -24, range: 340 } },
  { name: "Asakusa skyline", note: "Across the river from Azumabashi, seen from the Sumida side.", shot: { lon: 139.7985, lat: 35.7115, z: 30, heading: 285, pitch: -9, range: 1100 } },
];
const TIMES: [Light, string][] = [["morning", "Morning"], ["midday", "Midday"], ["sunset", "Sunset"]];
const NAV = ["Home", "Gallery", "Surroundings", "Amenities", "Flood"] as const;
const FLOOD_VIEW: Shot = { lon: 139.8135, lat: 35.7135, z: 0, heading: 35, pitch: -30, range: 1500 };
const FLOOD_SECONDS = 45; // the first water to the last, on screen
type Tab = (typeof NAV)[number];

interface Home {
  id: string; lon: number; lat: number; height: number; floors: number; footprint: number;
  district: string; far: number; land: number; river_depth: number | null; walk: Record<string, [number, number]>;
}

const yen = (v: number) => `¥${(v / 1e6).toLocaleString("en", { maximumFractionDigits: v < 1e8 ? 0 : 1 })}M`;
const perM2 = (h: Home) => (h.land / (h.far / 100) + BUILD_COST) / NET_TO_GROSS;
const metres = (a: { lon: number; lat: number }, b: { lon: number; lat: number }) =>
  Math.hypot((a.lon - b.lon) * 111320 * Math.cos((a.lat * Math.PI) / 180), (a.lat - b.lat) * 110574);
const eyebrow = "text-[10px] font-medium uppercase tracking-[0.22em] text-white/55";
const field = "w-full min-w-0 border-0 border-b border-white/25 bg-transparent py-1 text-[15px] tabular-nums text-white outline-none focus:border-white";
const chip = (on: boolean) => `h-8 min-w-8 border px-2.5 text-xs transition-colors duration-300 ${on ? "border-white bg-white text-black" : "border-white/25 text-white/80 hover:border-white/70"}`;

function Num({ label, value, set, step, unit }: { label: string; value: number; set: (v: number) => void; step: number; unit: string }) {
  return (
    <label className="block min-w-0">
      <span className="text-[11px] text-white/55">{label}</span>
      <span className="flex items-baseline gap-1">
        <input type="number" inputMode="numeric" min={0} step={step} className={field} value={value} aria-label={`${label} ${unit}`}
               onChange={(e) => set(Math.max(0, Number(e.target.value)))} />
        <span className="text-[11px] text-white/55">{unit}</span>
      </span>
    </label>
  );
}

function Fact({ k, v }: { k: string; v: ReactNode }) {
  return <div className="flex justify-between gap-4 border-t border-white/10 py-1.5"><span className="text-white/55">{k}</span><span className="text-right tabular-nums">{v}</span></div>;
}

export default function Residences() {
  const box = useRef<HTMLDivElement>(null);
  const estate = useRef<Estate | null>(null);
  const [data, setData] = useState<Json>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("Home");
  const [light, setLight] = useState<Light>("midday");
  const [shot, setShot] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [sources, setSources] = useState(false);
  const [photoreal, setPhotoreal] = useState(false);
  const [radius, setRadius] = useState(RADIUS.initial);
  const [status, setStatus] = useState<RenderStatus | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [showTiles, setShowTiles] = useState(false);
  const [field, setField] = useState<FloodField | null>(null);
  const [floodStep, setFloodStep] = useState(0);
  const [floodPlaying, setFloodPlaying] = useState(false);
  const homesRef = useRef<Home[]>([]);
  const [category, setCategory] = useState("parks");
  const [minArea, setMinArea] = useState(50), [maxArea, setMaxArea] = useState(100);
  const [minBudget, setMinBudget] = useState(40), [maxBudget, setMaxBudget] = useState(60);
  const [beds, setBeds] = useState<number | null>(null);

  const homes: Home[] = useMemo(() => (data?.homes ?? []).map((r: unknown[]) =>
    Object.fromEntries(data.fields.map((f: string, i: number) => [f, r[i]])) as unknown as Home), [data]);
  homesRef.current = homes;
  const byId = useMemo(() => new Map(homes.map((h) => [h.id, h])), [homes]);

  const filters = useDeferredValue({ minArea, maxArea, minBudget, maxBudget, beds });
  const size = Math.max(filters.minArea, filters.beds ? BEDROOM_M2[filters.beds] : 0);
  const results = useMemo(() => {
    if (size <= 0 || size > filters.maxArea) return [];
    return homes.filter((h) => {
      const price = perM2(h) * size;
      return h.footprint * NET_TO_GROSS >= size && price >= filters.minBudget * 1e6 && price <= filters.maxBudget * 1e6;
    }).sort((a, b) => a.walk.stations[0] - b.walk.stations[0] || b.floors - a.floors);
  }, [homes, size, filters]);
  const home = chosen ? byId.get(chosen) : undefined;

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const r = await fetch("/estate.json");
        if (!r.ok) throw new Error("The neighbourhood data could not be loaded.");
        const d = await r.json();
        if (dead) return;
        setData(d);
        const e = await createEstate(box.current!, d.tiles, (id, at) => {
          // On the photographic city only search results are pickable, so find the building at the spot clicked.
          const near = !id && at ? homesRef.current.reduce<Home | null>((best, h) => (metres(h, at) < 35 && (!best || metres(h, at) < metres(best, at)) ? h : best), null) : null;
          setChosen(id ?? near?.id ?? null);
        }, setStatus);
        if (dead) return e.destroy();
        estate.current = e;
        setPhotoreal(e.photoreal);
        e.setLight("midday");
        e.go(HOME, 0, true);
        setReady(true);
      } catch (e) {
        setFailed(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { dead = true; estate.current?.destroy(); estate.current = null; };
  }, []);

  useEffect(() => { if (ready) estate.current?.setLight(light); }, [ready, light]);
  useEffect(() => { if (ready) estate.current?.setRadius(radius); }, [ready, radius]);
  useEffect(() => { if (ready) estate.current?.showTiles(showTiles); }, [ready, showTiles]);
  const lastFloodStep = useMemo(() => (field ? field.arrive.reduce((m, a) => (a !== NEVER && a > m ? a : m), 0) + 3 : 1), [field]);
  useEffect(() => {
    if (tab !== "Flood" || field) return;
    loadFloodField().then(setField, (e) => setFailed(e instanceof Error ? e.message : String(e)));
  }, [tab, field]);
  useEffect(() => { if (ready) estate.current?.setFlood(tab === "Flood" ? field : null, floodStep); }, [ready, tab, field, floodStep]);
  useEffect(() => {
    if (!floodPlaying || tab !== "Flood" || !field) return;
    const timer = setInterval(() => setFloodStep((s) => {
      const next = s + (lastFloodStep / FLOOD_SECONDS) * 0.1;
      if (next >= lastFloodStep) setFloodPlaying(false);
      return Math.min(next, lastFloodStep);
    }), 100);
    return () => clearInterval(timer);
  }, [floodPlaying, tab, field, lastFloodStep]);
  const floodStats = useMemo(() => {
    if (!field) return null;
    let wet = 0;
    for (let c = 0; c < field.arrive.length; c++) if (depthAt(field, c, floodStep) > 0) wet++;
    const reached = homes.filter((h) => {
      const i = Math.floor(((h.lon - field.west) / (field.east - field.west)) * field.w), j = Math.floor(((h.lat - field.south) / (field.north - field.south)) * field.h);
      return i >= 0 && j >= 0 && i < field.w && j < field.h && depthAt(field, i + j * field.w, floodStep) > 0;
    }).length;
    const m = field.steps[Math.min(Math.floor(floodStep), field.steps.length - 1)];
    return { km2: (wet * field.cell * field.cell) / 1e6, reached, time: `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min` };
  }, [field, floodStep, homes]);
  useEffect(() => {
    if (ready) estate.current?.setMatches(tab === "Home" ? new Set(results.map((h) => h.id)) : new Set(), chosen);
  }, [ready, results, chosen, tab]);

  // Amenity pins: the nearest of the chosen kind around the selected building, or the featured towers.
  const focus = home ?? HERO;
  const nearby: Json[] = useMemo(() => (data?.amenities[category] ?? [])
    .map(([name, lon, lat]: [string, number, number]) => ({ label: name, lon, lat, away: metres(focus, { lon, lat }) }))
    .sort((a: Json, b: Json) => a.away - b.away).slice(0, 12), [data, category, focus]);
  useEffect(() => {
    // Over the photographic city, a marker keeps the chosen building easy to find.
    const mark = photoreal && home ? [{ lon: home.lon, lat: home.lat, label: home.district, z: home.height + 8 }] : [];
    if (ready) estate.current?.setPins(tab === "Amenities" ? [...nearby, ...mark] : mark);
  }, [ready, tab, nearby, photoreal, home]);

  function fly(s: Shot, name: string | null, drift = false) {
    setShot(name);
    // Google's mesh melts up close, so its views stay above the rooftops.
    estate.current?.go(photoreal ? { ...s, pitch: Math.min(s.pitch, -8), range: Math.max(s.range, 320) } : s, 4.2, drift);
  }
  function openTab(t: Tab) {
    setTab(t);
    setPanelOpen(true);
    setShot(null);
    if (t === "Home") fly(HOME, null, true);
    if (t === "Gallery") fly(GALLERY[1].shot, GALLERY[1].name);
    if (t === "Surroundings") fly(SIGHTS[0].shot, SIGHTS[0].name);
    if (t === "Flood") { fly(FLOOD_VIEW, null); setFloodStep(0); setFloodPlaying(true); }
    if (t === "Amenities") fly({ ...focus, z: 0, heading: 0, pitch: -58, range: 1250 }, null);
  }
  function viewHome(h: Home) {
    setChosen(h.id);
    fly({ lon: h.lon, lat: h.lat, z: h.height * 0.55, heading: 205, pitch: -16, range: Math.max(190, h.height * 3.4) }, null);
  }
  useEffect(() => {
    if (ready && tab === "Amenities") estate.current?.go({ ...focus, z: 0, heading: 0, pitch: -58, range: 1250 }, 2.4);
  }, [category]);

  const inRadius = useMemo(() => (status ? homes.filter((h) => metres(h, status) <= radius).length : 0), [homes, status, radius]);
  const panel = "pointer-events-auto border border-white/15 bg-[#14120f]/70 text-white shadow-[0_18px_60px_rgba(0,0,0,0.35)] backdrop-blur-xl";
  return (
    <div className="relative h-full overflow-hidden bg-[#14120f] text-[13px] leading-5 text-white">
      <div ref={box} className="absolute inset-0" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-black/45 to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-64 bg-gradient-to-t from-black/45 to-transparent" />

      <div className={`absolute inset-0 z-30 grid place-items-center bg-[#14120f] px-6 text-center transition-opacity duration-[1400ms] ${ready ? "pointer-events-none opacity-0" : ""}`}>
        <div>
          <div className="text-[clamp(2.4rem,7vw,5.5rem)] font-light leading-none tracking-[0.14em]">SUMIDA</div>
          <p className="mt-5 text-white/60">{failed ? `The 3D city could not start. ${failed}` : "Preparing the city"}</p>
          {failed && <a className="mt-3 inline-block underline underline-offset-4" href="#/twin">Open the digital twin instead</a>}
        </div>
      </div>

      <header className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center gap-4 px-4 pt-4 sm:px-8 sm:pt-6">
        <div className="text-[15px] font-light tracking-[0.3em]">SUMIDA</div>
        <div className="ml-auto" />
        <div className={`pointer-events-auto flex items-center gap-1 ${photoreal ? "hidden" : ""}`} role="group" aria-label="Time of day">
          {TIMES.map(([id, label]) => (
            <button key={id} aria-pressed={light === id} onClick={() => setLight(id)} className={`px-2 py-1 text-xs transition-colors ${light === id ? "text-white" : "text-white/55 hover:text-white"}`}>{label}</button>
          ))}
        </div>
        <button className="pointer-events-auto hidden text-xs text-white/70 hover:text-white sm:block" onClick={() => setSources(!sources)}>Sources</button>
        <a className="pointer-events-auto text-xs text-white/70 hover:text-white" href="#/twin">Digital twin</a>
      </header>

      {sources && (
        <div className={`${panel} rise absolute right-4 top-14 z-20 w-[min(22rem,calc(100%-2rem))] p-4 text-xs text-white/75 sm:right-8`}>
          {photoreal && <p className="mb-2">3D imagery: Google, delivered through Cesium ion. PLATEAU supplies the building data behind the search.</p>}
          <p>Buildings, trees and bridges: MLIT Project PLATEAU 2025. Where PLATEAU has no wall photos, roofs use GSI aerial photos and walls are illustrative: shapes and heights are real, wall materials and windows are not. Aerial photos: GSI. Land prices: MLIT official land price survey {data?.land_year}, {data?.land_points} survey points. Amenities and walking routes: © OpenStreetMap contributors.</p>
          <p className="mt-2">No homes are listed here. Prices are estimates: nearest official land price divided by the plot's permitted floor-area ratio, plus an assumed ¥{BUILD_COST.toLocaleString("en")} per m² to build, over {NET_TO_GROSS * 100}% usable floor. Real sale prices differ.</p>
        </div>
      )}

      {home && (
        <aside key={home.id} className={`${panel} rise absolute right-4 top-14 z-10 max-h-[24vh] w-[min(20rem,calc(100%-2rem))] overflow-y-auto p-4 sm:right-8 sm:top-20 sm:max-h-[calc(100%-22rem)] lg:max-h-[calc(100%-7rem)]`}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className={eyebrow}>Apartment building</div>
              <h2 className="mt-1 text-xl font-light tracking-[-0.01em]">{home.district}</h2>
            </div>
            <button aria-label="Close building details" className="px-1 text-lg leading-none text-white/60 hover:text-white" onClick={() => setChosen(null)}>×</button>
          </div>
          <div className="mt-3 text-3xl font-light tabular-nums">{home.footprint * NET_TO_GROSS >= size && size > 0 ? yen(perM2(home) * size) : "—"}</div>
          <p className="mb-3 text-xs text-white/55">Estimate for {size} m². Not an asking price; no home here is listed.</p>
          <Fact k="Floors" v={home.floors} />
          <Fact k="Height" v={`${home.height.toFixed(0)} m`} />
          <Fact k="Footprint" v={`${home.footprint.toLocaleString("en")} m²`} />
          <Fact k="Land price nearby" v={`¥${home.land.toLocaleString("en")}/m²`} />
          <Fact k="Permitted floor-area ratio" v={`${home.far}%`} />
          <Fact k="River flood depth (worst case)" v={home.river_depth === null ? "None mapped" : `${home.river_depth.toFixed(1)} m`} />
          {Object.entries(home.walk).map(([c, [minutes, i]]) => (
            <Fact key={c} k={data.labels[c]} v={<>{minutes} min<span className="block max-w-40 truncate text-[11px] text-white/50">{data.amenities[c][i][0]}</span></>} />
          ))}
        </aside>
      )}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center p-3 sm:p-6">
        <section className={`${panel} max-h-[52vh] w-full max-w-5xl overflow-y-auto`}>
          {panelOpen && <div key={tab} className="rise p-4">
            {tab === "Home" && (
              <>
                <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                  <h1 className={eyebrow}>Unit search</h1>
                  <p className="text-xs tabular-nums text-white/70" aria-live="polite">{results.length.toLocaleString("en")} of {homes.length.toLocaleString("en")} real apartment buildings could fit a {size} m² home</p>
                </div>
                <div className={`mt-3 grid-cols-2 gap-x-5 gap-y-3 md:grid md:grid-cols-[1fr_1fr_1fr_1fr_auto_auto] ${home ? "hidden" : "grid"}`}>
                  <Num label="Min surface" unit="m²" step={5} value={minArea} set={setMinArea} />
                  <Num label="Max surface" unit="m²" step={5} value={maxArea} set={setMaxArea} />
                  <Num label="Min budget" unit="¥M" step={5} value={minBudget} set={setMinBudget} />
                  <Num label="Max budget" unit="¥M" step={5} value={maxBudget} set={setMaxBudget} />
                  <div>
                    <div className="mb-1 text-[11px] text-white/55">Bedrooms</div>
                    <div className="flex gap-1">{[1, 2, 3].map((n) => <button key={n} aria-pressed={beds === n} className={chip(beds === n)} onClick={() => setBeds(beds === n ? null : n)}>{n}</button>)}</div>
                  </div>
                  <div>
                    <div className="mb-1 text-[11px] text-white/55">Bathrooms</div>
                    <div className="flex h-8 items-center text-xs text-white/45">Not in public data</div>
                  </div>
                </div>
                {results.length > 0 ? (
                  <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
                    {results.slice(0, 8).map((h) => (
                      <button key={h.id} onClick={() => viewHome(h)} className={`w-44 shrink-0 border p-2 text-left transition-colors duration-300 ${chosen === h.id ? "border-white" : "border-white/15 hover:border-white/50"}`}>
                        <span className="block truncate">{h.district}</span>
                        <span className="block text-base font-light tabular-nums">{yen(perM2(h) * size)}</span>
                        <span className="block text-[11px] tabular-nums text-white/55">{h.floors} floors · {h.walk.stations[0]} min to station</span>
                      </button>
                    ))}
                  </div>
                ) : <p className="mt-3 text-xs text-white/70">{size > filters.maxArea ? `${filters.beds} bedroom${filters.beds === 1 ? "" : "s"} needs about ${size} m². Raise the maximum surface.` : "No building fits. Widen the budget or surface."}</p>}
                <p className="mt-2 text-[11px] text-white/45">Gold buildings are real; orange is the one you chose. Prices are estimates from official land prices, not listings.</p>
              </>
            )}
            {tab === "Gallery" && (
              <>
                <h1 className={eyebrow}>Gallery</h1>
                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                  {GALLERY.map((g) => (
                    <button key={g.name} aria-pressed={shot === g.name} className={`border px-3 py-3 text-left transition-colors duration-300 ${shot === g.name ? "border-white bg-white/10" : "border-white/15 hover:border-white/50"}`}
                            onClick={() => { fly(g.shot, g.name); if (g.light && !photoreal) setLight(g.light); }}>{photoreal && g.light ? "Skytree" : g.name}</button>
                  ))}
                </div>
              </>
            )}
            {tab === "Surroundings" && (
              <>
                <h1 className={eyebrow}>Surroundings</h1>
                <div className="mt-3 flex flex-wrap gap-2">
                  {SIGHTS.map((s) => <button key={s.name} aria-pressed={shot === s.name} className={`${chip(shot === s.name)} h-9`} onClick={() => fly(s.shot, s.name)}>{s.name}</button>)}
                </div>
                <p className="mt-3 max-w-2xl text-white/75">{SIGHTS.find((s) => s.name === shot)?.note ?? "Choose a place to travel to it."}</p>
              </>
            )}
            {tab === "Flood" && (
              <>
                <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                  <h1 className={eyebrow}>River flood simulation</h1>
                  <p className="text-xs text-white/60">{field?.scenario ?? "Loading the scenario…"}</p>
                </div>
                <div className="mt-3 flex items-center gap-3">
                  <button className={chip(floodPlaying)} disabled={!field} onClick={() => { if (floodStep >= lastFloodStep) setFloodStep(0); setFloodPlaying(!floodPlaying); }}>{floodPlaying ? "Pause" : "Play"}</button>
                  <input type="range" className="min-w-0 flex-1" aria-label="Time since the levee breach" min={0} max={lastFloodStep} step={0.05} value={floodStep}
                         onChange={(e) => { setFloodPlaying(false); setFloodStep(Number(e.target.value)); }} />
                  <span className="text-lg font-light tabular-nums">{floodStats?.time ?? "—"}</span>
                </div>
                {floodStats && <p className="mt-2 text-xs tabular-nums text-white/70">{floodStats.km2.toFixed(1)} km² under water here · {floodStats.reached.toLocaleString("en")} of {homes.length.toLocaleString("en")} apartment buildings reached</p>}
                <p className="mt-1 text-[11px] text-white/45">Hypothetical breach: extent, timing and depth bands are GSI's published scenario. Waves and particle motion are an illustrative physics effect, sped up. Not a forecast or evacuation guidance.</p>
              </>
            )}
            {tab === "Amenities" && (
              <>
                <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                  <h1 className={eyebrow}>Amenities</h1>
                  <p className="text-xs text-white/60">Nearest to {home ? home.district : "Kyojima's towers"}</p>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {Object.entries<string>(data?.labels ?? {}).map(([id, label]) => <button key={id} aria-pressed={category === id} className={chip(category === id)} onClick={() => setCategory(id)}>{label}</button>)}
                </div>
                <ol className="mt-3 grid grid-cols-1 gap-x-6 sm:grid-cols-2 lg:grid-cols-3">
                  {nearby.slice(0, 6).map((p) => <li key={p.label + p.lon} className="flex justify-between gap-3 border-t border-white/10 py-1.5"><span className="truncate">{p.label}</span><span className="shrink-0 tabular-nums text-white/55">{Math.round(p.away / 10) * 10} m</span></li>)}
                </ol>
              </>
            )}
          </div>}
          <div className="sticky bottom-[41px] border-t border-white/15 bg-[#14120f]/90 px-4 py-2">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
              <label className="flex min-w-56 flex-1 items-center gap-3">
                <span className={eyebrow}>Render radius</span>
                <input type="range" className="min-w-0 flex-1" aria-label="Render radius in metres" min={RADIUS.min} max={RADIUS.max} step={50}
                       value={radius} onChange={(e) => setRadius(Number(e.target.value))} />
                <span className="w-14 text-right tabular-nums">{radius >= 1000 ? `${(radius / 1000).toFixed(2)} km` : `${radius} m`}</span>
              </label>
              <button className="text-white/70 hover:text-white" aria-pressed={showTiles} onClick={() => setShowTiles(!showTiles)}>{showTiles ? "Hide tiles" : "Show tiles"}</button>
              <button className="text-white/70 hover:text-white" aria-expanded={panelOpen} onClick={() => setPanelOpen(!panelOpen)}>{panelOpen ? "Hide panel" : "Show panel"}</button>
              <p className="w-full tabular-nums text-white/60" aria-live="off">
                {(Math.PI * radius * radius / 1e6).toFixed(1)} km² sharp · {inRadius} apartment buildings · camera {Math.round(status?.height ?? 0).toLocaleString("en")} m ·{" "}
                LOD 0–3: {(status?.lod ?? [0, 0, 0, 0]).join(" / ")} tiles{status?.levels && ` · HLOD levels ${status.levels[0]}–${status.levels[1]}`} ·{" "}
                {status?.loading ? `loading ${status.loading}` : "loaded"} · {Math.round(status?.memoryMB ?? 0)} MB
              </p>
              <p className="w-full text-[11px] text-white/45">Drag to move · right-drag to tilt and turn · scroll to zoom where you point · WASD and Q/E to fly, Shift for speed</p>
            </div>
          </div>
          <nav className="sticky bottom-0 flex border-t border-white/15 bg-[#14120f]/80" aria-label="Sections">
            {NAV.map((t) => (
              <button key={t} aria-current={tab === t ? "page" : undefined} onClick={() => openTab(t)}
                      className={`flex-1 px-1 py-3 text-[10px] font-medium uppercase tracking-[0.16em] transition-colors duration-300 sm:text-[11px] sm:tracking-[0.22em] ${tab === t ? "text-white" : "text-white/50 hover:text-white"}`}>{t}</button>
            ))}
          </nav>
        </section>
      </div>
    </div>
  );
}
