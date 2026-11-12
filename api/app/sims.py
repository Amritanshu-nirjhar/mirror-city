"""Simulators on top of the published data: area-wide breach flooding, evacuation on foot,
transit access and rooftop solar.

Where and when the water is comes only from GSI's published breach-scenario tiles. What is
modelled here is people: where they live (an estimate), which streets they can still walk,
and whether their building has a floor above the water. Every assumption is a named constant
below and is returned to the client with the results.
"""
import functools
import heapq
import io
import math
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Annotated

import httpx
import numpy as np
import shapely
from fastapi import APIRouter, HTTPException, Query
from PIL import Image

from . import gsi
from .db import row, rows

router = APIRouter(prefix="/api")
ROOT = Path(__file__).resolve().parents[2]
# Precomputed flood rasters ship with the code (read-only). New ones go to CACHE_DIR, which is
# /tmp on Vercel because the deployed filesystem is read-only.
SHIPPED = Path(__file__).resolve().parents[1] / "cache"  # api/cache
CACHE = Path(os.environ.get("CACHE_DIR", ROOT / "data" / "cache"))

Z, TILE = 14, 256  # the zoom the 3D view draws: about 8 m per pixel here
# GSI's standard flood-depth legend, shallow to deep, and the top of each depth class in metres.
LEGEND = np.array([[247, 245, 169], [255, 216, 192], [255, 183, 183], [255, 145, 145], [242, 133, 201], [220, 122, 220]])
CLASS_TOP = [0.5, 3, 5, 10, 20, 40]  # the last class is "20 m or more"; 40 stands in for it
IMPASSABLE = 1  # depth class from which a street cannot be walked and a ground floor floods: 0.5 m or more
NEVER = 65535

# --- Assumptions (calibration knobs) ---
# ponytail: residents are estimated from floor area because the project holds no census data.
# Upgrade path: scale each block to the census small-area population (e-Stat).
M2_PER_RESIDENT = 50.0  # gross residential floor area per person
RESIDENTIAL = {"住宅": 1.0, "共同住宅": 1.0, "店舗等併用住宅": 0.5, "店舗等併用共同住宅": 0.5, "作業所併用住宅": 0.5}
STOREY_M = 3.0
MIN_DRY_NODES = 200  # a patch of dry streets smaller than this is an island, not somewhere to flee to
STATION_WALK = 80.0  # metres per minute: the Japanese real-estate convention for walking times
# Rooftop solar: share of the roof that can carry panels, module efficiency, system performance ratio.
ROOF_USABLE, PV_EFFICIENCY, PV_PERFORMANCE = 0.5, 0.20, 0.80


# ---------- flood raster ----------

def _tile(url):
    """Depth class per pixel of one GSI tile (-1 dry), or None where GSI publishes no tile (no water)."""
    for _ in range(3):
        try:
            r = gsi._client.get(url)
        except httpx.TransportError:
            continue
        if r.status_code == 404:
            return None
        if r.status_code == 200:
            a = np.asarray(Image.open(io.BytesIO(r.content)).convert("RGBA"), np.int32)
            nearest = ((a[:, :, None, :3] - LEGEND) ** 2).sum(-1).argmin(-1)
            return np.where(a[:, :, 3] > 40, nearest, -1).astype(np.int8)
    # A tile that fails must never be read as "dry".
    raise gsi.UpstreamError(f"GSI flood tile unavailable: {url}")


def _tile_xy(lon, lat):
    n = 2 ** Z
    return (lon + 180) / 360 * n, (1 - np.arcsinh(np.tan(np.radians(lat))) / np.pi) / 2 * n


_build = threading.Lock()  # ponytail: one scenario is downloaded at a time; per-scenario locks if several users wait


@functools.lru_cache(maxsize=4)
def flood(breach_id):
    """The scenario over the whole walking network: per pixel, the first published time step
    with 0.5 m or more of water, and the deepest class reached. Built once, then kept on disk."""
    s = row("SELECT * FROM flood_scenarios WHERE gsi_breach_id = %s", (breach_id,))
    if not s:
        raise HTTPException(404, "Unknown scenario. Discover scenarios for a coordinate with /api/flood/scenarios first.")
    template = gsi.tile_template(s["office_code"], s["rainfall_scale"], s["river_code"], s["sub_river_code"], s["breach_name"])
    if not template or not s["time_steps"]:
        raise HTTPException(422, "GSI publishes no map tiles for this scenario, so it cannot be simulated area-wide.")
    g = graph()
    x0, y0 = (int(v) for v in _tile_xy(g["lon"].min(), g["lat"].max()))
    x1, y1 = (int(v) for v in _tile_xy(g["lon"].max(), g["lat"].min()))
    w, h = x1 - x0 + 1, y1 - y0 + 1
    # The tile window is part of the name: a re-ingested, wider network must not reuse a smaller raster.
    name = f"flood_{breach_id}_{x0}_{y0}_{w}x{h}.npz"
    path = next((p for p in (SHIPPED / name, CACHE / name) if p.exists()), CACHE / name)
    with _build:
        if not path.exists():
            first = np.full((h * TILE, w * TILE), NEVER, np.uint16)
            deepest = np.full(first.shape, -1, np.int8)
            # ponytail: 4 tiles at a time, like one browser tab of the 3D view. The ~30 requests a
            # minute guidance in gsi.py is for the JSON API; these are static map tiles.
            with ThreadPoolExecutor(4) as pool:
                for k, minutes in enumerate(s["time_steps"]):
                    urls = [gsi.tile_url(template, minutes, Z, x0 + i, y0 + j) for j in range(h) for i in range(w)]
                    for n, t in enumerate(pool.map(_tile, urls)):
                        if t is None:
                            continue
                        j, i = divmod(n, w)
                        win = np.s_[j * TILE:(j + 1) * TILE, i * TILE:(i + 1) * TILE]
                        first[win] = np.where((t >= IMPASSABLE) & (first[win] == NEVER), k, first[win])
                        deepest[win] = np.maximum(deepest[win], t)
            path.parent.mkdir(parents=True, exist_ok=True)
            np.savez_compressed(path, first=first, deepest=deepest, origin=[x0, y0], steps=s["time_steps"])
    d = np.load(path)
    return {"first": d["first"], "deepest": d["deepest"], "origin": d["origin"], "steps": d["steps"].astype(float),
            "name": f"{s['river_name']} {s['breach_location']} ({s['breach_name']})"}


def sample(r, layer, lon, lat):
    """Raster values at lon/lat arrays. Outside the raster counts as never flooded."""
    a = r[layer]
    tx, ty = _tile_xy(np.asarray(lon), np.asarray(lat))
    px, py = ((tx - r["origin"][0]) * TILE).astype(int), ((ty - r["origin"][1]) * TILE).astype(int)
    ok = (px >= 0) & (py >= 0) & (px < a.shape[1]) & (py < a.shape[0])
    out = np.full(px.shape, NEVER if layer == "first" else -1, a.dtype)
    out[ok] = a[py[ok], px[ok]]
    return out


def flooded_from(r, lon, lat):
    """Minute of the first published step with 0.5 m or more at each point; None where it never comes."""
    k = sample(r, "first", lon, lat)
    return [None if i == NEVER else float(r["steps"][i]) for i in k]


# ---------- walking network and buildings ----------

def components(n, a, b):
    """Connected-component label per node (union-find)."""
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i, j in zip(a.tolist(), b.tolist()):
        parent[find(i)] = find(j)
    return np.array([find(i) for i in range(n)])


@functools.cache
def graph():
    nodes = rows("SELECT id, lon, lat, near_water FROM walk_nodes ORDER BY id")
    if not nodes:
        raise HTTPException(503, "Walking network not ingested yet. Run python -m ingestion.ingest_network.")
    index = {n["id"]: i for i, n in enumerate(nodes)}
    lon, lat = np.array([n["lon"] for n in nodes]), np.array([n["lat"] for n in nodes])
    lon0, lat0 = lon.mean(), lat.mean()
    # Local metres. Over a few kilometres a flat projection is exact to well under a metre per kilometre.
    kx, ky = 111_320 * math.cos(math.radians(lat0)), 110_574
    x, y = (lon - lon0) * kx, (lat - lat0) * ky
    edges = rows("SELECT a, b, elevated FROM walk_edges")
    a, b = np.array([index[e["a"]] for e in edges]), np.array([index[e["b"]] for e in edges])
    elevated = np.array([e["elevated"] for e in edges])
    length = np.hypot(x[a] - x[b], y[a] - y[b])
    adj = [[] for _ in nodes]
    for e, (i, j) in enumerate(zip(a.tolist(), b.tolist())):
        adj[i].append((j, e))
        adj[j].append((i, e))
    label = components(len(nodes), a, b)
    main = label == np.bincount(label).argmax()  # stray fragments (private yards, mapping gaps) lead nowhere
    on_bridge = np.zeros(len(nodes), bool)
    on_bridge[a[elevated]] = on_bridge[b[elevated]] = True
    return {"lon": lon, "lat": lat, "x": x, "y": y, "a": a, "b": b, "elevated": elevated, "length": length,
            "adj": adj, "main": main, "refuge_ok": main & ~on_bridge & ~np.array([n["near_water"] for n in nodes]),
            "to_xy": lambda lo, la: ((np.asarray(lo) - lon0) * kx, (np.asarray(la) - lat0) * ky),
            "tree": shapely.STRtree(shapely.points(x[main], y[main])), "tree_nodes": np.flatnonzero(main)}


def attach(g, lon, lat):
    """Nearest network node to each point, and the straight-line distance to it in metres."""
    x, y = g["to_xy"](lon, lat)
    node = g["tree_nodes"][g["tree"].nearest(shapely.points(x, y))]
    return node, np.hypot(g["x"][node] - x, g["y"][node] - y)


@functools.cache
def buildings():
    b = rows("""SELECT b.gml_id, b.usage, greatest(coalesce(b.floors, ceil(b.height / %s)::int, 1), 1) AS floors,
                       ST_Area(b.footprint_geometry) AS area, ST_X(p.pt) AS lon, ST_Y(p.pt) AS lat
                FROM buildings b
                CROSS JOIN LATERAL (SELECT ST_Transform(ST_PointOnSurface(b.footprint_geometry), 4326) AS pt) p
                ORDER BY b.id""", (STOREY_M,))
    lon, lat = np.array([r["lon"] for r in b]), np.array([r["lat"] for r in b])
    floors, area = np.array([r["floors"] for r in b]), np.array([r["area"] for r in b])
    people = area * floors * np.array([RESIDENTIAL.get(r["usage"], 0.0) for r in b]) / M2_PER_RESIDENT
    node, access = attach(graph(), lon, lat)
    return {"gml_id": [r["gml_id"] for r in b], "lon": lon, "lat": lat, "floors": floors, "people": people,
            "node": node, "access": access}


def nearest_source(g, sources):
    """Shortest walking distance from every node to the nearest of `sources` [(node, start metres, label)]."""
    dist, label = [math.inf] * len(g["adj"]), [-1] * len(g["adj"])
    heap = []
    for node, d0, tag in sources:
        if d0 < dist[node]:
            dist[node], label[node] = d0, tag
            heap.append((d0, node))
    heapq.heapify(heap)
    length = g["length"].tolist()
    while heap:
        d, w = heapq.heappop(heap)
        if d > dist[w]:
            continue
        for v, e in g["adj"][w]:
            if d + length[e] < dist[v]:
                dist[v], label[v] = d + length[e], label[w]
                heapq.heappush(heap, (dist[v], v))
    return np.array(dist), np.array(label)


# ---------- evacuation ----------

def latest_departures(adj, minutes, length, closes, safe):
    """For every node, the latest minute a walker can set off and still reach a safe node.

    An edge can be used only if it is crossed before it closes. Working backwards from the
    safe nodes: latest(v) = max over edges v-w of min(latest(w), closes(edge)) - walking time.
    Ties go to the shorter walk. Returns (latest, metres to walk, next node on the way)."""
    n = len(adj)
    latest, dist, nxt = [-math.inf] * n, [math.inf] * n, [-1] * n
    heap = []
    for s in safe:
        latest[s], dist[s] = math.inf, 0.0
        heap.append((-math.inf, 0.0, s))
    heapq.heapify(heap)
    while heap:
        neg, d, w = heapq.heappop(heap)
        if (-neg, d) != (latest[w], dist[w]):
            continue
        for v, e in adj[w]:
            cand, far = min(latest[w], closes[e]) - minutes[e], d + length[e]
            if cand >= 0 and (cand > latest[v] or (cand == latest[v] and far < dist[v])):
                latest[v], dist[v], nxt[v] = cand, far, w
                heapq.heappush(heap, (-cand, far, v))
    return latest, dist, nxt


@functools.lru_cache(maxsize=8)
def evacuation(breach_id, speed):
    r, g, b = flood(breach_id), graph(), buildings()
    steps = r["steps"]
    last_dry = np.concatenate(([0.0], steps[:-1], [math.inf]))  # by first-flooded step index; the end is "never"
    step_of = lambda k: np.where(k == NEVER, len(steps), k)

    # When each street segment closes: the last published step before 0.5 m of water lies anywhere along it.
    n = np.maximum(np.ceil(g["length"] / 6).astype(int), 1) + 1  # a sample every 6 m or less
    start = np.concatenate(([0], np.cumsum(n)[:-1]))
    e = np.repeat(np.arange(len(n)), n)
    u = (np.arange(n.sum()) - start[e]) / (n[e] - 1)
    a, bb = g["a"][e], g["b"][e]
    along = sample(r, "first", g["lon"][a] + u * (g["lon"][bb] - g["lon"][a]), g["lat"][a] + u * (g["lat"][bb] - g["lat"][a]))
    edge_first = np.minimum.reduceat(along, start)
    edge_first[g["elevated"]] = NEVER
    closes = last_dry[step_of(edge_first)]

    # Dry ground: streets the scenario never wets at all, away from rivers and bridges, in a patch big enough to matter.
    dry = g["refuge_ok"] & (sample(r, "deepest", g["lon"], g["lat"]) == -1)
    keep = dry[g["a"]] & dry[g["b"]] & (edge_first == NEVER)
    patch = components(len(dry), g["a"][keep], g["b"][keep])
    safe = dry & (np.bincount(patch[dry], minlength=len(dry))[patch] >= MIN_DRY_NODES)

    minutes = (g["length"] / (speed * 60)).tolist()
    latest, dist, nxt = latest_departures(g["adj"], minutes, g["length"].tolist(), closes.tolist(), np.flatnonzero(safe).tolist())
    latest, dist = np.array(latest), np.array(dist)

    # Buildings: when 0.5 m reaches them, how deep it gets, and whether a floor stays above it.
    k = sample(r, "first", b["lon"], b["lat"])
    reached = k != NEVER
    arrives = np.where(reached, steps[np.minimum(k, len(steps) - 1)], math.inf)
    top = np.array(CLASS_TOP)[np.maximum(sample(r, "deepest", b["lon"], b["lat"]), 0)]
    upstairs = b["floors"] >= np.ceil(top / STOREY_M) + 1
    # Leave before the water is at the door and before the route closes.
    out = np.minimum(latest[b["node"]] - b["access"] / (speed * 60), last_dry[step_of(k)])
    out = np.where(out >= 0, np.minimum(out, steps[-1]), -1.0)
    people = np.where(reached, b["people"], 0.0)

    def split(t):
        gone = out >= t
        return {"minutes": float(t), "can_walk_out": float(people[gone].sum()),
                "upstairs_only": float(people[~gone & upstairs].sum()),
                "stranded": float(people[~gone & ~upstairs].sum()),
                "buildings_flooded": int((arrives <= t).sum()), "residents_flooded": float(b["people"][arrives <= t].sum())}

    # People per street segment if everyone with a way out takes it: add each building's residents down its route.
    load = np.zeros(len(dist))
    np.add.at(load, b["node"], np.where(out >= 0, people, 0.0))
    nxt_a = np.array(nxt)
    for v in np.argsort(-np.where(np.isfinite(dist), dist, -1)).tolist():  # farthest first
        if nxt_a[v] >= 0:
            load[nxt_a[v]] += load[v]
    used = np.flatnonzero((nxt_a >= 0) & (load >= 1))
    used = used[np.argsort(-load[used])][:4000]  # ponytail: the 4000 busiest segments are drawn; the rest are side streets
    close_of = {(i, j): c for i, j, c in zip(g["a"].tolist(), g["b"].tolist(), closes.tolist())}
    flows = [[round(g["lon"][v], 6), round(g["lat"][v], 6), round(g["lon"][w], 6), round(g["lat"][w], 6), round(load[v]),
              None if math.isinf(c := min(close_of.get((v, w), math.inf), close_of.get((w, v), math.inf))) else c]
             for v, w in zip(used.tolist(), nxt_a[used].tolist())]

    refuges = rows("SELECT name, address, remarks, lon, lat FROM refuges ORDER BY id")
    for site, t in zip(refuges, flooded_from(r, [s["lon"] for s in refuges], [s["lat"] for s in refuges])):
        site["flooded_from"] = t
    ids = np.flatnonzero(reached).tolist()
    return {
        "scenario": r["name"], "steps": steps.tolist(), "speed_m_s": speed,
        "residents_total": float(b["people"].sum()), "residents_flooded": float(people.sum()),
        "buildings_total": len(k), "buildings_flooded": int(reached.sum()),
        "dry_ground": bool(safe.any()),
        "at_breach": split(0), "timeline": [split(t) for t in steps],
        # gml_id -> [minute 0.5 m arrives, latest minute to leave on foot (-1: no way out), floor above water, residents]
        "buildings": {b["gml_id"][i]: [float(arrives[i]), float(out[i]), bool(upstairs[i]), round(float(people[i]), 1)] for i in ids},
        "flows": flows, "refuges": refuges,
        "_route": (nxt, dist, out),
        "assumptions": {
            "impassable_depth_m": CLASS_TOP[IMPASSABLE - 1], "walking_speed_m_s": speed,
            "m2_floor_area_per_resident": M2_PER_RESIDENT, "storey_height_m": STOREY_M,
            "residential_share_by_usage": RESIDENTIAL, "min_dry_patch_nodes": MIN_DRY_NODES,
        },
        "method": (
            "Water is GSI's published breach scenario, read from its map tiles at every time step; nothing "
            "hydraulic is simulated. A street closes at the last published step before 0.5 m of water lies on it "
            "and stays closed. Bridges stay open. People walk the OpenStreetMap network to the nearest ground the "
            "scenario never wets. Residents are estimated from residential floor area, so counts are indicative; "
            "shares are more reliable. Crowding does not slow anyone down, and nobody drives. "
            "This is a planning sketch, not official evacuation guidance."),
    }


Speed = Annotated[float, Query(ge=0.3, le=2.0)]


@router.get("/evacuation/{breach_id}")
def evacuation_result(breach_id: str, speed: Speed = 1.0):
    return {k: v for k, v in evacuation(breach_id, round(speed, 1)).items() if not k.startswith("_")}


@router.get("/evacuation/{breach_id}/route")
def evacuation_route(breach_id: str, gml_id: str, speed: Speed = 1.0):
    """The walk from one building to dry ground, as a line."""
    res, g, b = evacuation(breach_id, round(speed, 1)), graph(), buildings()
    if gml_id not in b["gml_id"]:
        raise HTTPException(404, f"No building {gml_id} in the ingested area of interest.")
    i = b["gml_id"].index(gml_id)
    nxt, dist, out = res["_route"]
    if out[i] < 0:
        return {"line": None, "message": "No walkable route to dry ground exists from the moment of the breach."}
    line, v = [[float(b["lon"][i]), float(b["lat"][i])]], int(b["node"][i])
    metres = float(dist[v] + b["access"][i])
    while v >= 0:
        line.append([float(g["lon"][v]), float(g["lat"][v])])
        v = nxt[v]
    return {"line": line, "distance_m": metres, "walk_minutes": metres / (res["speed_m_s"] * 60), "leave_by_minutes": float(out[i])}


# ---------- transit ----------

@functools.cache
def transit_base():
    stops = rows("""SELECT stop_id, name, mode, operator, lon, lat, weekday_departures, daytime_per_hour, routes
                    FROM transit_stops ORDER BY id""")
    if not stops:
        raise HTTPException(503, "Transit stops not ingested yet. Run ingestion.ingest_network and ingestion.ingest_transit.")
    g, b = graph(), buildings()
    node, access = attach(g, [s["lon"] for s in stops], [s["lat"] for s in stops])
    out = {}
    for key, wanted in (("any", lambda s: True), ("rail", lambda s: s["mode"] == "rail")):
        d, which = nearest_source(g, [(int(n), float(a), i) for i, (n, a, s) in enumerate(zip(node, access, stops)) if wanted(s)])
        out[key] = ((d[b["node"]] + b["access"]) / STATION_WALK, which[b["node"]])
    return stops, out


@router.get("/transit")
def transit(breach_id: str | None = None):
    """Walking time from every building to its nearest stop and nearest rail station."""
    stops, t = transit_base()
    b = buildings()
    (any_min, any_stop), (rail_min, rail_stop) = t["any"], t["rail"]
    people, total = b["people"], b["people"].sum()
    wet = flooded_from(flood(breach_id), [s["lon"] for s in stops], [s["lat"] for s in stops]) if breach_id else [None] * len(stops)
    share = lambda mask: float(100 * people[mask].sum() / total)
    return {
        "stops": [{**s, "flooded_from": w} for s, w in zip(stops, wet)],
        # gml_id -> [minutes to nearest stop, its index in stops, minutes to nearest rail station, its index, residents]
        "buildings": {i: [round(float(a), 1), int(s), round(float(r), 1), int(rs), round(float(n), 1)]
                      for i, a, s, r, rs, n in zip(b["gml_id"], any_min, any_stop, rail_min, rail_stop, people) if math.isfinite(a)},
        "summary": {"residents": float(total), "within_5_min_of_a_stop": share(any_min <= 5),
                    "within_10_min_of_rail": share(rail_min <= 10), "beyond_10_min_of_any_stop": share(any_min > 10),
                    "bus_stops": sum(s["mode"] == "bus" for s in stops), "rail_stations": sum(s["mode"] == "rail" for s in stops)},
        "assumptions": {"walking_m_per_min": STATION_WALK, "m2_floor_area_per_resident": M2_PER_RESIDENT},
        "method": ("Walking time along OpenStreetMap streets at 80 m a minute, door to stop. Bus stops and their weekday "
                   "departures are Toei Bus's open timetable; other bus operators publish none and are missing. Rail "
                   "stations are locations only. With a flood scenario, a stop counts as out of use once 0.5 m of water "
                   "reaches it; the streets on the way are not checked."),
    }


# ---------- solar ----------

@router.get("/solar")
def solar():
    """Rooftop solar potential per building: shaded yearly sunshine times a share of the roof."""
    data = rows("""SELECT b.gml_id, ST_Area(b.footprint_geometry) AS area, s.irradiation_kwh_m2 AS sun, s.open_sky_kwh_m2 AS open
                   FROM building_solar s JOIN buildings b ON b.id = s.building_id""")
    if not data:
        raise HTTPException(503, "Solar potential not computed yet. Run python -m ingestion.ingest_solar.")
    per_m2 = ROOF_USABLE * PV_EFFICIENCY * PV_PERFORMANCE  # kWh generated per kWh of sunshine on a square metre of roof
    area, sun = np.array([d["area"] for d in data]), np.array([d["sun"] for d in data])
    kwh = area * sun * per_m2
    return {
        # gml_id -> [sunshine on the roof kWh/m2/year, generation MWh/year, capacity kWp]
        "buildings": {d["gml_id"]: [round(d["sun"]), round(float(e) / 1000, 1), round(d["area"] * ROOF_USABLE * PV_EFFICIENCY, 1)]
                      for d, e in zip(data, kwh)},
        "summary": {"buildings": len(data), "generation_gwh_year": float(kwh.sum() / 1e6),
                    "capacity_mwp": float(area.sum() * ROOF_USABLE * PV_EFFICIENCY / 1000),
                    "roof_area_m2": float(area.sum()), "open_sky_kwh_m2": data[0]["open"],
                    "median_roof_kwh_m2": float(np.median(sun)),
                    "lost_to_shading_percentage": float(100 * (1 - (area * sun).sum() / (area.sum() * data[0]["open"])))},
        "assumptions": {"usable_roof_share": ROOF_USABLE, "module_efficiency": PV_EFFICIENCY, "performance_ratio": PV_PERFORMANCE},
        "method": ("Yearly sunshine is NASA POWER's 2001-2025 average for this location, reduced roof by roof for the hours "
                   "a taller PLATEAU building stands between the roof and the sun (2 m grid, hourly sun positions for one "
                   "day a month). Roofs are treated as flat at the building's measured height; roof pitch, rooftop "
                   "equipment and trees are not modelled, and buildings outside the pilot area cast no shadow. "
                   "Generation assumes panels on half of each roof."),
    }


def demo():
    # A street A - B - C with dry ground at C. B-C floods at minute 30; each segment takes 10 minutes.
    adj = [[(1, 0)], [(0, 0), (2, 1)], [(1, 1)]]
    latest, dist, nxt = latest_departures(adj, [10, 10], [600, 600], [math.inf, 30], [2])
    assert latest == [10, 20, math.inf] and dist == [1200, 600, 0] and nxt == [1, 2, -1], (latest, dist, nxt)
    # If B-C is already under water at the breach, nobody gets out.
    assert latest_departures(adj, [10, 10], [600, 600], [math.inf, 0], [2])[0][:2] == [-math.inf, -math.inf]
    assert components(4, np.array([0, 2]), np.array([1, 3])).tolist() == [1, 1, 3, 3]


if __name__ == "__main__":
    demo()
