// Real-time sections: slice the 3D city with a movable plane and draw what the plane passes
// through, with ground level, schematic floors and the selected flood scenario's water.
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { api, type Json, type Point, type Scenario } from "./api";
import type { Scene } from "./viewer";

const LENGTHS = [150, 300, 600, 1000];
const SWEEP_M = 240; // the sweep runs this far either side of the chosen point
const fmt = (v: number, digits = 0) => v.toLocaleString("en", { maximumFractionDigits: digits });

/** Runs one request at a time; values arriving meanwhile collapse into the newest. */
function useLatest<T>(run: (value: T) => Promise<void>) {
  const state = useRef<{ busy: boolean; next: T | null }>({ busy: false, next: null });
  const latest = useRef(run);
  latest.current = run;
  return async (value: T) => {
    const s = state.current;
    s.next = value;
    if (s.busy) return;
    s.busy = true;
    while (s.next !== null) {
      const v = s.next;
      s.next = null;
      await latest.current(v);
    }
    s.busy = false;
  };
}

/** Water reached at a stretch of the cut by minute `t`: GSI's depth class, as [low, high] metres. */
function waterAt(flood: Json, step: number, from: number, to: number, t: number) {
  let low = 0, high = 0;
  for (let i = Math.round(from / step); i <= Math.round(to / step); i++) {
    if (flood?.arrives[i] != null && flood.arrives[i] <= t) {
      low = Math.max(low, flood.low[i]);
      high = Math.max(high, flood.high[i]);
    }
  }
  return [low, high];
}

const buildingWater = (b: Json, flood: Json, step: number, t: number) =>
  b.cut.reduce((m: number, [from, to]: number[]) => Math.max(m, waterAt(flood, step, from, to, t)[0]), 0);
const wetFloors = (b: Json, depth: number) => {
  const storey = b.height / b.floors;
  return Math.min(b.floors, Math.ceil(depth / storey - 1e-9));
};

function Drawing({ d, flood, t, selected, onPick }: { d: Json; flood: Json; t: number | undefined; selected: string | null; onPick: (id: string) => void }) {
  const W = 680, H = 176, foot = 14;
  const ground: number[] = d.ground ?? [0];
  const at = (s: number) => ground[Math.min(Math.round(s / d.step), ground.length - 1)] ?? ground[0];
  const base = (b: Json) => at((b.span[0] + b.span[1]) / 2);
  const tops = [...d.cut, ...d.behind].map((b: Json) => base(b) + b.height);
  const peak = t === undefined ? 0 : Math.max(0, ...ground.map((g, i) => (flood?.arrives[i] != null && flood.arrives[i] <= t ? g + flood.high[i] : g)));
  const zMin = Math.min(...ground) - 3, zMax = Math.max(12, peak, ...tops) + 2;
  const sx = W / d.length, sy = Math.min(3 * sx, (H - foot - 6) / (zMax - zMin));
  const x = (s: number) => s * sx, y = (z: number) => H - foot - (z - zMin) * sy;
  const line = ground.map((g, i) => `${x(i * d.step)},${y(g)}`).join(" ");
  const sea = y(0);
  return (
    <figure className="m-0">
      <svg viewBox={`0 0 ${W} ${H}`} className="block w-full" role="img" aria-label="Section drawing along the cut line">
        {d.behind.map((b: Json) => (
          <rect key={b.gml_id} x={x(b.span[0])} width={Math.max(x(b.span[1] - b.span[0]), 0.5)} y={y(base(b) + b.height)} height={b.height * sy}
                fill="currentColor" opacity={0.05 + 0.1 * (1 - b.depth / d.behind_m)} />
        ))}
        {t !== undefined && flood && ground.map((g, i) => {
          const [low, high] = flood.arrives[i] != null && flood.arrives[i] <= t ? [flood.low[i], flood.high[i]] : [0, 0];
          return high > 0 && (
            <g key={i} fill="#38bdf8">
              <rect x={x((i - 0.5) * d.step)} width={x(d.step) + 0.3} y={y(g + high)} height={(high - low) * sy} opacity="0.16" />
              <rect x={x((i - 0.5) * d.step)} width={x(d.step) + 0.3} y={y(g + low)} height={low * sy} opacity="0.5" />
            </g>
          );
        })}
        {d.cut.map((b: Json) => {
          const z0 = base(b), storey = b.height / b.floors;
          const wet = t === undefined ? 0 : wetFloors(b, buildingWater(b, flood, d.step, t));
          return (
            <g key={b.gml_id} className="cursor-pointer" onClick={() => onPick(b.gml_id)}>
              <title>{`${b.usage ?? "Building"} · ${fmt(b.height, 1)} m · ${b.floors} floors${b.floors_known ? "" : " (estimated)"}`}</title>
              {b.cut.map(([from, to]: number[]) => (
                <g key={from}>
                  <rect x={x(from)} width={Math.max(x(to - from), 1)} y={y(z0 + b.height)} height={b.height * sy}
                        fill="var(--color-bg)" stroke={b.gml_id === selected ? "#ffffff" : "var(--color-accent)"} strokeWidth={b.gml_id === selected ? 1.6 : 1} />
                  {Array.from({ length: b.floors }, (_, i) => (
                    <rect key={i} x={x(from)} width={Math.max(x(to - from), 1)} y={y(z0 + (i + 1) * storey)} height={storey * sy}
                          fill={i < wet ? "#38bdf8" : "none"} fillOpacity="0.55" stroke="var(--color-accent)" strokeOpacity="0.35" strokeWidth="0.5" />
                  ))}
                </g>
              ))}
            </g>
          );
        })}
        <polygon points={`0,${H - foot} ${line} ${W},${H - foot}`} fill="var(--color-line)" />
        <polyline points={line} fill="none" stroke="currentColor" strokeWidth="1" />
        {sea > 0 && sea < H - foot && <line x1="0" x2={W} y1={sea} y2={sea} stroke="currentColor" strokeDasharray="2 4" opacity="0.45" />}
      </svg>
      <figcaption className="mt-1 flex justify-between gap-4 text-[11px] tabular-nums text-dim">
        <span>0 m</span>
        <span>Dashed line: sea level · heights × {fmt(sy / sx, 1)}{flood && t !== undefined ? " · pale blue: top of the depth class" : ""}</span>
        <span>{fmt(d.length)} m</span>
      </figcaption>
    </figure>
  );
}

export function useSection(
  active: boolean, scene: RefObject<Scene | null>, ready: boolean, point: Point | undefined,
  scenario: Scenario | null, minutes: number | undefined, gmlId: string | null,
  pick: (id: string) => void, fail: (e: unknown) => void,
) {
  const breach = scenario && !scenario.stages && scenario.tile_url_template ? scenario.id : null;
  const [kind, setKind] = useState<"section" | "plan">("section");
  const [origin, setOrigin] = useState<Point | null>(null);
  const [heading, setHeading] = useState(90);
  const [offset, setOffset] = useState(0);
  const [length, setLength] = useState(300);
  const [level, setLevel] = useState(12);
  const [sweep, setSweep] = useState(false);
  const [data, setData] = useState<Json>(null);
  const [flood, setFlood] = useState<Json>(null);
  const [floodNote, setFloodNote] = useState<string | null>(null);
  const [plan, setPlan] = useState<Json>(null);
  const fromDrawing = useRef(false);
  const framed = useRef(false);

  // Clicking a building or the ground moves the cut there; picking one in the drawing does not.
  useEffect(() => {
    if (!active || !point) return;
    if (fromDrawing.current) fromDrawing.current = false;
    else {
      setOrigin(point);
      setOffset(0);
    }
  }, [active, point?.lon, point?.lat]);

  const h = (heading * Math.PI) / 180;
  const centre = useMemo(() => origin && {
    lon: origin.lon + (offset * Math.cos(h)) / (111320 * Math.cos((origin.lat * Math.PI) / 180)),
    lat: origin.lat - (offset * Math.sin(h)) / 110574,
  }, [origin, offset, h]);
  const query = centre && { lon: +centre.lon.toFixed(7), lat: +centre.lat.toFixed(7), heading: heading % 360, length };

  const loadSection = useLatest<Json>(async (q) => {
    try {
      setData({ ...(await api("/section", q)), q });
    } catch (e) {
      fail(e);
    }
  });
  const loadFlood = useLatest<Json>(async (q) => {
    try {
      setFlood(await api("/section/flood", q));
      setFloodNote(null);
    } catch {
      setFlood(null); // the section itself still works without water
      setFloodNote("This scenario's flood maps could not be read in time. Try again, or use the worst-case scenario.");
    }
  });

  // The 3D cut follows every change at once; the data catches up as fast as it can.
  useEffect(() => {
    const s = scene.current;
    if (!s || !ready) return;
    if (!active || !centre) return s.setSection(null);
    s.setSection(kind === "plan" ? { kind, ...centre, level } : { kind, ...centre, heading });
    if (!framed.current) {
      framed.current = true;
      s.faceSection(centre, heading);
    }
  }, [active, ready, kind, centre, heading, level]);
  useEffect(() => {
    if (!active) framed.current = false;
    if (!active) setSweep(false);
  }, [active]);

  const key = query && kind === "section" && active ? JSON.stringify(query) : "";
  useEffect(() => {
    if (key) loadSection(query);
  }, [key]);
  useEffect(() => {
    setFlood(null);
    setFloodNote(null);
  }, [breach]);
  useEffect(() => {
    if (key && breach) loadFlood({ ...query, breach_id: breach });
  }, [key, breach]);
  useEffect(() => {
    if (!active || kind !== "plan") return;
    const timer = setTimeout(() => api("/section/plan", { height: level }).then(setPlan, fail), 150);
    return () => clearTimeout(timer);
  }, [active, kind, level]);

  useEffect(() => {
    if (!sweep) return;
    const timer = setInterval(() => setOffset((o) => (o + 3 > SWEEP_M ? -SWEEP_M : o + 3)), 70);
    return () => clearInterval(timer);
  }, [sweep]);

  const shown = active && kind === "section" ? data : null;
  const t = breach ? minutes : undefined;
  const step = shown?.step ?? 5;
  const water = t !== undefined ? flood : null;
  const wetByBuilding = useMemo(() => {
    const m = new Map<string, number>();
    if (shown && water && t !== undefined) for (const b of shown.cut) m.set(b.gml_id, wetFloors(b, buildingWater(b, water, step, t)));
    return m;
  }, [shown, water, t, step]);

  // Floor plates inside the cut buildings, blue where the water has reached them.
  const slabKey = shown ? `${JSON.stringify(shown.q)}|${[...wetByBuilding.values()].join()}` : "";
  useEffect(() => {
    if (!ready) return;
    scene.current?.setSectionFloors(shown ? shown.cut.map((b: Json) => ({ ...b, wet: wetByBuilding.get(b.gml_id) ?? 0 })) : [], shown?.ends ?? null)
      .catch(fail);
  }, [slabKey, ready]);

  if (!active) return { panel: null, drawing: null, inspector: null };

  const label = "flex items-center justify-between gap-3 text-xs text-dim";
  const chip = (on: boolean) => `border px-2 py-1 text-xs transition-colors ${on ? "border-ink text-ink" : "border-line text-dim hover:text-ink"}`;
  const floors = shown?.cut.reduce((n: number, b: Json) => n + b.floors, 0) ?? 0;
  const wet = [...wetByBuilding.values()].reduce((a, b) => a + b, 0);
  const ground: number[] | null = shown?.ground ?? null;

  const panel: ReactNode = (
    <div className="rise pointer-events-auto space-y-2.5">
      <div className="flex gap-2">
        <button className={chip(kind === "section")} aria-pressed={kind === "section"} onClick={() => setKind("section")}>Vertical section</button>
        <button className={chip(kind === "plan")} aria-pressed={kind === "plan"} onClick={() => setKind("plan")}>Floor plan cut</button>
      </div>
      {kind === "section" ? (
        <>
          <label className={label}>Direction <span className="tabular-nums">{heading}°</span></label>
          <input type="range" className="w-full" aria-label="Cut direction in degrees" min={0} max={359} value={heading} onChange={(e) => setHeading(Number(e.target.value))} />
          <label className={label}>Move cut <span className="tabular-nums">{offset > 0 ? "+" : ""}{offset} m</span></label>
          <input type="range" className="w-full" aria-label="Move the cut forwards or backwards" min={-SWEEP_M} max={SWEEP_M} value={offset} onChange={(e) => setOffset(Number(e.target.value))} />
          <div className="flex flex-wrap items-center gap-2">
            <button className={chip(sweep)} aria-pressed={sweep} onClick={() => setSweep(!sweep)}>{sweep ? "Stop sweep" : "Sweep"}</button>
            <button className={chip(false)} onClick={() => centre && scene.current?.faceSection(centre, heading)}>Face the cut</button>
            <select aria-label="Length of the section" className="border border-line bg-transparent px-1.5 py-1 text-xs text-ink" value={length} onChange={(e) => setLength(Number(e.target.value))}>
              {LENGTHS.map((l) => <option key={l} value={l}>{l} m long</option>)}
            </select>
          </div>
          {shown && (
            <p className="text-xs tabular-nums text-dim">
              Cuts {shown.cut.length} buildings and {fmt(floors)} floors{ground && ` · ground ${fmt(Math.min(...ground), 1)} to ${fmt(Math.max(...ground), 1)} m above sea level`}
              {water && ` · ${fmt(wet)} floors reached by water`}.
            </p>
          )}
          {!breach && <p className="text-xs text-dim">Press “Run river flood” to put the water into the section.</p>}
          {floodNote && <p className="text-xs text-accent">{floodNote}</p>}
          <p className="text-xs text-dim">Floors are the building height divided evenly: schematic, not surveyed interiors.</p>
        </>
      ) : (
        <>
          <label className={label}>Cut height <span className="tabular-nums">{level} m above ground</span></label>
          <input type="range" className="w-full" aria-label="Height of the horizontal cut" min={1} max={120} value={level} onChange={(e) => setLevel(Number(e.target.value))} />
          {plan && <p className="text-xs tabular-nums text-dim">{fmt(plan.buildings)} buildings rise above this height, with {fmt(plan.area_m2 / 10000, 1)} ha of footprint.</p>}
        </>
      )}
    </div>
  );

  const drawing: ReactNode = shown && (
    <Drawing d={shown} flood={water} t={t} selected={gmlId} onPick={(id) => {
      fromDrawing.current = true;
      pick(id);
    }} />
  );

  const b = shown?.cut.find((c: Json) => c.gml_id === gmlId);
  const inspector: ReactNode = b && (
    <>
      <div className="flex justify-between gap-3 py-1"><span className="text-dim">Floors in the cut</span><span className="tabular-nums">{b.floors}{b.floors_known ? "" : " (estimated)"}</span></div>
      <div className="flex justify-between gap-3 py-1"><span className="text-dim">Average storey</span><span className="tabular-nums">{fmt(b.height / b.floors, 1)} m</span></div>
      {water && <div className="flex justify-between gap-3 py-1"><span className="text-dim">Floors reached by water</span><span className="tabular-nums">{wetByBuilding.get(b.gml_id) ?? 0}</span></div>}
    </>
  );
  return { panel, drawing, inspector };
}
