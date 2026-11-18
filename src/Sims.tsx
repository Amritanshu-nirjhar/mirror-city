// The simulators that sit on top of the flood view: evacuation on foot, transit access and
// rooftop solar. Each one colours the buildings, adds its map overlays, and supplies a headline
// for the left column and a block for the building inspector.
import { useEffect, useMemo, useState, type ReactNode, type RefObject } from "react";
import { api, type Json, type Scenario } from "./api";
import type { Scene } from "./viewer";

export type Mode = "flood" | "evacuation" | "transit" | "solar" | "section";
export const MODES: { id: Mode; label: string }[] = [
  { id: "flood", label: "Flood" },
  { id: "evacuation", label: "Evacuation" },
  { id: "transit", label: "Transit" },
  { id: "solar", label: "Solar" },
  { id: "section", label: "Sections" },
];

const EVAC = { out: "#34d399", up: "#facc15", stuck: "#ef4444" };
// Walking minutes to the nearest stop: up to 3, 5, 8, and beyond.
const WALK: [number, string][] = [[3, "#a7f3d0"], [5, "#fde68a"], [8, "#fb923c"], [Infinity, "#ef4444"]];
// Roof sunshine as a share of open sky: under 60%, 75%, 85%, 95%, and above.
const SUN: [number, string][] = [[0.6, "#3b1a6e"], [0.75, "#7c2d92"], [0.85, "#d9486e"], [0.95, "#f59e42"], [Infinity, "#fde047"]];
const SPEEDS = [[0.5, "Slow, 0.5 m/s"], [1, "Average, 1.0 m/s"], [1.3, "Brisk, 1.3 m/s"]] as const;
const bin = (ramp: [number, string][], v: number) => ramp.find(([top]) => v <= top)![1];
const num = (v: number, digits = 0) => v.toLocaleString("en", { maximumFractionDigits: digits });

function clock(minutes: number) {
  const d = Math.floor(minutes / 1440), h = Math.floor((minutes % 1440) / 60), m = Math.round(minutes % 60);
  return `${d ? `${d} d ` : ""}${h} h ${String(m).padStart(2, "0")} min`;
}

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex justify-between gap-3 py-1">
      <span className="text-dim">{k}</span>
      <span className="text-right tabular-nums">{v}</span>
    </div>
  );
}

function Legend({ items }: { items: [string, string][] }) {
  return (
    <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-dim">
      {items.map(([colour, label]) => (
        <span key={label} className="flex items-center gap-1.5">
          <i className="h-2 w-2 rounded-full" style={{ background: colour }} />
          {label}
        </span>
      ))}
    </div>
  );
}

function Headline({ figure, unit, children }: { figure: string; unit?: string; children: ReactNode }) {
  return (
    <div className="rise pointer-events-auto">
      <div className="font-medium leading-[0.85] tracking-[-0.06em] text-[clamp(3.5rem,7vw,6rem)]">
        {figure}
        {unit && <span className="text-[0.4em] tracking-[-0.02em] text-dim"> {unit}</span>}
      </div>
      {children}
    </div>
  );
}

/** Share of residents of flooded buildings who can still walk out, over the published steps (not to scale in time). */
function WalkOutChart({ timeline, total, at }: { timeline: Json[]; total: number; at: number }) {
  const W = 256, H = 48;
  const x = (i: number) => (i / Math.max(timeline.length - 1, 1)) * W;
  const y = (t: Json) => H - (t.can_walk_out / Math.max(total, 1)) * H;
  const line = timeline.map((t, i) => `${x(i)},${y(t)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-3 w-64 overflow-visible border-b border-line" role="img"
         aria-label="Share of residents who can still walk out, by time since the breach">
      <polygon points={`0,${H} ${line} ${W},${H}`} fill={EVAC.out} opacity="0.18" />
      <polyline points={line} fill="none" stroke={EVAC.out} strokeWidth="1.25" />
      {at >= 0 && <line x1={x(at)} x2={x(at)} y1={0} y2={H} stroke="var(--color-accent)" strokeWidth="1" />}
    </svg>
  );
}

export function useSim(
  mode: Mode, scene: RefObject<Scene | null>, ready: boolean, scenario: Scenario | null,
  minutes: number | undefined, gmlId: string | null, fail: (e: unknown) => void,
) {
  // Only a GSI breach scenario with map tiles has timed, area-wide water.
  const breach = scenario && !scenario.stages && scenario.tile_url_template ? scenario.id : null;
  const [speed, setSpeed] = useState(1);
  const [data, setData] = useState<{ key: string; d: Json } | null>(null);
  const [route, setRoute] = useState<Json>(null);
  const key = mode === "evacuation" ? (breach ? `evacuation:${breach}:${speed}` : "") : mode === "transit" ? `transit:${breach ?? ""}` : mode === "solar" ? "solar" : "";
  const d = data?.key === key ? data.d : null;
  const t = minutes ?? 0;

  useEffect(() => {
    if (!key) return;
    let stale = false;
    const load = mode === "evacuation" ? api(`/evacuation/${breach}`, { speed })
      : mode === "transit" ? api("/transit", breach ? { breach_id: breach } : {})
      : api("/solar");
    load.then((r) => !stale && setData({ key, d: r }), fail);
    return () => {
      stale = true;
    };
  }, [key]);

  // Building colours for the current mode and scenario time.
  const colours = useMemo(() => {
    if (!d) return null;
    const m = new Map<string, string>();
    if (mode === "evacuation")
      for (const [id, [, leaveBy, upstairs]] of Object.entries<Json>(d.buildings))
        m.set(id, t <= leaveBy ? EVAC.out : upstairs ? EVAC.up : EVAC.stuck);
    else if (mode === "transit")
      for (const [id, [walk, stop]] of Object.entries<Json>(d.buildings)) {
        const wet = d.stops[stop].flooded_from;
        m.set(id, wet !== null && wet <= t ? "#475569" : bin(WALK, walk));
      }
    else for (const [id, [sun]] of Object.entries<Json>(d.buildings)) m.set(id, bin(SUN, sun / d.summary.open_sky_kwh_m2));
    return m;
  }, [d, mode, t]);

  useEffect(() => {
    scene.current?.colourBuildings(colours);
  }, [colours, ready]);

  // Map overlays: flows and refuges for evacuation, stops for transit.
  useEffect(() => {
    const s = scene.current;
    if (!s) return;
    s.setFlows(mode === "evacuation" && d ? d.flows : null);
    s.setMarkers(
      !d ? []
        : mode === "evacuation"
        ? d.refuges.map((r: Json) => ({ ...r, colour: r.flooded_from !== null && r.flooded_from <= t ? "#ef4444" : "#ffffff", size: 9 }))
        : mode === "transit"
        ? d.stops.map((p: Json) => ({ ...p, colour: p.flooded_from !== null && p.flooded_from <= t ? "#ef4444" : p.mode === "rail" ? "#60a5fa" : "#ffffff",
                                      size: p.mode === "rail" ? 11 : 6 }))
        : [],
    );
  }, [d, mode, ready, mode === "solar" ? 0 : t]);
  useEffect(() => {
    scene.current?.setFlowTime(t);
  }, [t, d]);

  // The selected building's walk to dry ground.
  const own = d && gmlId ? d.buildings[gmlId] : undefined;
  useEffect(() => {
    setRoute(null);
    scene.current?.setRoute(null);
    if (mode !== "evacuation" || !breach || !gmlId || !own) return;
    let stale = false;
    api(`/evacuation/${breach}/route`, { gml_id: gmlId, speed }).then((r) => {
      if (stale) return;
      setRoute(r);
      scene.current?.setRoute(r.line);
    }, fail);
    return () => {
      stale = true;
    };
  }, [mode, breach, gmlId, speed, !!own]);

  let headline: ReactNode = null, inspector: ReactNode = null;
  const waiting = (what: string) => <p className="rise max-w-64 text-[15px] leading-snug text-dim">{what}</p>;

  if (mode === "evacuation") {
    if (!breach) headline = waiting("Evacuation needs timed water. Press “Run river flood” to start a breach scenario.");
    else if (!d) headline = waiting("Reading GSI's flood maps for every time step of this scenario. The first run takes about two minutes.");
    else {
      const at = d.timeline.findIndex((s: Json) => s.minutes === t);
      const now = at >= 0 ? d.timeline[at] : d.at_breach;
      headline = (
        <Headline figure={num(now.stranded)}>
          <p className="mt-3 max-w-64 text-[15px] leading-snug">
            residents with no walkable way out and no floor above the water, if they have not left by {clock(t)}.
          </p>
          <p className="mt-1 max-w-64 text-xs tabular-nums text-dim">
            {num(now.can_walk_out)} can still walk to dry ground · {num(now.upstairs_only)} can only go upstairs · of {num(d.residents_flooded)} residents
            in the {num(d.buildings_flooded)} buildings this breach floods. {num(now.buildings_flooded)} buildings are in 0.5 m or more by now.
          </p>
          <WalkOutChart timeline={d.timeline} total={d.residents_flooded} at={at} />
          <Legend items={[[EVAC.out, "can walk out"], [EVAC.up, "upstairs only"], [EVAC.stuck, "no way out"], ["#5eead4", "routes used"]]} />
          <label className="mt-3 flex items-center gap-2 text-xs text-dim">
            Walking speed
            <select className="border border-line bg-transparent px-1.5 py-1 text-ink" value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
              {SPEEDS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
          </label>
          <p className="mt-2 max-w-64 text-xs text-dim">
            Resident counts are estimated from floor area. Crowding and cars are not modelled. A sketch for planning, not evacuation guidance.
          </p>
        </Headline>
      );
      if (gmlId)
        inspector = !own ? <p>0.5 m of water never reaches this building in this scenario.</p> : (
          <>
            <Row k="0.5 m of water arrives" v={clock(own[0])} />
            <Row k="Leave on foot by" v={own[1] < 0 ? "No way out" : own[1] >= d.steps[d.steps.length - 1] ? "Open throughout" : clock(own[1])} />
            <Row k="A floor above the water" v={own[2] ? "Yes" : "No"} />
            <Row k="Residents (estimate)" v={num(own[3])} />
            {route?.line && <Row k="Walk to dry ground" v={`${num(route.distance_m)} m · ${num(route.walk_minutes)} min`} />}
            {route?.message && <p className="mt-2 text-xs text-accent">{route.message}</p>}
            <p className="mt-3 text-xs text-dim">The white line is the route. A street closes at the last published step before 0.5 m of water lies on it.</p>
          </>
        );
    }
  } else if (mode === "transit") {
    if (!d) headline = waiting(breach ? "Loading stops and this scenario's flood maps…" : "Loading stops and walking times…");
    else {
      let near = 0, cut = 0;
      for (const [walk, stop, , , people] of Object.values<Json>(d.buildings)) {
        const wet = d.stops[stop].flooded_from;
        if (wet !== null && wet <= t) cut += people;
        else if (walk <= 5) near += people;
      }
      const flooded = d.stops.filter((p: Json) => p.flooded_from !== null && p.flooded_from <= t).length;
      headline = (
        <Headline figure={num((100 * near) / d.summary.residents, 0)} unit="%">
          <p className="mt-3 max-w-64 text-[15px] leading-snug">
            of residents live within a 5-minute walk of a bus stop or station{breach ? ` still above water at ${clock(t)}` : ""}.
          </p>
          <p className="mt-1 max-w-64 text-xs tabular-nums text-dim">
            {num(d.summary.within_10_min_of_rail, 0)}% are within 10 minutes of a rail station · {d.summary.bus_stops} Toei bus stops,{" "}
            {d.summary.rail_stations} stations.
            {breach && ` ${flooded} stops are under 0.5 m or more; the nearest stop of ${num((100 * cut) / d.summary.residents, 0)}% of residents is one of them.`}
          </p>
          <Legend items={[[WALK[0][1], "up to 3 min"], [WALK[1][1], "5"], [WALK[2][1], "8"], [WALK[3][1], "more"], ...(breach ? [["#475569", "stop under water"] as [string, string]] : [])]} />
          <p className="mt-2 max-w-64 text-xs text-dim">
            Walking at 80 m a minute along mapped streets. Only Toei Bus publishes an open timetable here, so other bus operators are missing.
            {!breach && " Run a river flood to see which stops go under."}
          </p>
        </Headline>
      );
      const mine = gmlId ? d.buildings[gmlId] : undefined;
      if (mine) {
        const stop = d.stops[mine[1]], rail = d.stops[mine[3]];
        inspector = (
          <>
            <Row k="Nearest stop" v={`${stop.name} · ${num(mine[0])} min`} />
            {stop.mode === "bus" && <Row k="Weekday buses" v={`${num(stop.daytime_per_hour, 1)} an hour by day · ${num(stop.weekday_departures)} a day`} />}
            {stop.routes && <Row k="Routes" v={stop.routes.join(", ")} />}
            {rail && <Row k="Nearest station" v={`${rail.name} · ${num(mine[2])} min`} />}
            {stop.flooded_from !== null && <Row k="Stop under 0.5 m from" v={clock(stop.flooded_from)} />}
          </>
        );
      }
    }
  } else if (mode === "solar") {
    if (!d) headline = waiting("Loading rooftop sunshine…");
    else {
      const s = d.summary;
      headline = (
        <Headline figure={num(s.generation_gwh_year)} unit="GWh">
          <p className="mt-3 max-w-64 text-[15px] leading-snug">a year could come from panels on half of every roof in the pilot area.</p>
          <p className="mt-1 max-w-64 text-xs tabular-nums text-dim">
            {num(s.capacity_mwp)} MW of panels on {num(s.buildings)} roofs · open sky gives {num(s.open_sky_kwh_m2)} kWh/m² a year ·
            neighbouring buildings shade away {num(s.lost_to_shading_percentage, 1)}%.
          </p>
          <Legend items={[[SUN[0][1], "under 60% of open sky"], [SUN[1][1], "75%"], [SUN[2][1], "85%"], [SUN[3][1], "95%"], [SUN[4][1], "more"]]} />
          <p className="mt-2 max-w-64 text-xs text-dim">
            Roofs are treated as flat. Pitch, rooftop equipment and trees are not modelled: an upper estimate of what the roofs receive.
          </p>
        </Headline>
      );
      const mine = gmlId ? d.buildings[gmlId] : undefined;
      if (mine)
        inspector = (
          <>
            <Row k="Sunshine on the roof" v={`${num(mine[0])} kWh/m² a year`} />
            <Row k="Share of open sky" v={`${num((100 * mine[0]) / s.open_sky_kwh_m2)}%`} />
            <Row k="Panel capacity" v={`${num(mine[2], 1)} kW`} />
            <Row k="Generation" v={`${num(mine[1], 1)} MWh a year`} />
            <p className="mt-3 text-xs text-dim">Panels on half the roof, 20% efficient, 80% system performance.</p>
          </>
        );
    }
  }
  return { headline, inspector, title: MODES.find((m) => m.id === mode)!.label };
}
