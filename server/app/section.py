"""Real-time section cuts: what a vertical plane through the city passes through.

Building outlines, heights and floor counts are PLATEAU's. Ground level is GSI's 5 m elevation
model (metres above Tokyo Bay mean sea level). PLATEAU has no interiors for ordinary buildings,
so floors are drawn by dividing the height evenly: they are schematic.
"""
import functools
import io
import math
from typing import Annotated

import httpx
import numpy as np
import shapely
from fastapi import APIRouter, HTTPException, Query
from PIL import Image

from . import gsi, sims
from .db import row, rows

router = APIRouter(prefix="/api/section")
DEM = "https://cyberjapandata.gsi.go.jp/xyz/dem5a_png/15/{x}/{y}.png"
STEP_M = 5.0  # spacing of ground and flood samples along the cut
BEHIND_M = 40.0  # how far behind the cut buildings are still drawn
CLASS_LOW = [0.0, 0.5, 3, 5, 10, 20]  # lower bound of each GSI depth class; the tops are sims.CLASS_TOP

Lon = Annotated[float, Query(ge=139.7, le=139.9)]
Lat = Annotated[float, Query(ge=35.6, le=35.8)]
Heading = Annotated[float, Query(ge=0, lt=360)]
Length = Annotated[float, Query(ge=100, le=1000)]


def decode_dem(rgb):
    """GSI elevation PNG to metres; NaN where there is no value (rivers, sea)."""
    x = rgb[..., 0].astype(np.int64) * 65536 + rgb[..., 1].astype(np.int64) * 256 + rgb[..., 2]
    z = np.where(x < 2 ** 23, x, x - 2 ** 24) * 0.01
    return np.where(x == 2 ** 23, np.nan, z)


@functools.lru_cache(maxsize=64)
def dem_tile(x, y):
    try:
        r = gsi._client.get(DEM.format(x=x, y=y))
    except httpx.TransportError:
        return None
    if r.status_code != 200:
        return None
    return decode_dem(np.asarray(Image.open(io.BytesIO(r.content)).convert("RGB")))


def ground(lon, lat):
    """Elevation at each point. Gaps (a river under the cut) are bridged; None if GSI gave nothing."""
    n = 2 ** 15
    tx = (lon + 180) / 360 * n
    ty = (1 - np.arcsinh(np.tan(np.radians(lat))) / np.pi) / 2 * n
    z = np.full(lon.shape, np.nan)
    for i, (x, y) in enumerate(zip(tx, ty)):
        t = dem_tile(int(x), int(y))
        if t is not None:
            z[i] = t[int((y % 1) * 256), int((x % 1) * 256)]
    known = np.isfinite(z)
    if not known.any():
        return None
    return np.round(np.interp(np.arange(len(z)), np.flatnonzero(known), z[known]), 2).tolist()


def frame(lon, lat, heading, length):
    """The cut in EPSG:6677: its two ends, and the strip behind it that the viewer looks into."""
    c = row("SELECT ST_X(p) AS x, ST_Y(p) AS y FROM ST_Transform(ST_SetSRID(ST_MakePoint(%s, %s), 4326), 6677) p", (lon, lat))
    h = math.radians(heading)
    d, n = np.array([math.sin(h), math.cos(h)]), np.array([math.cos(h), -math.sin(h)])
    a, b = np.array([c["x"], c["y"]]) - d * length / 2, np.array([c["x"], c["y"]]) + d * length / 2
    return a, b, d, n, shapely.Polygon([a, b, b + n * BEHIND_M, a + n * BEHIND_M])


def line_points(a, b, length):
    """Lon/lat of the samples along the cut."""
    e = row("""SELECT ST_X(p) AS lon, ST_Y(p) AS lat, ST_X(q) AS lon2, ST_Y(q) AS lat2 FROM
               ST_Transform(ST_SetSRID(ST_MakePoint(%s, %s), 6677), 4326) p,
               ST_Transform(ST_SetSRID(ST_MakePoint(%s, %s), 6677), 4326) q""", (*map(float, a), *map(float, b)))
    u = np.arange(0, length + STEP_M / 2, STEP_M) / length
    return (e["lon"] + u * (e["lon2"] - e["lon"]), e["lat"] + u * (e["lat2"] - e["lat"]),
            [[e["lon"], e["lat"]], [e["lon2"], e["lat2"]]])


def spans(geom, a, d, length):
    """Stretches of the cut (metres from its start) covered by a line geometry."""
    out = []
    for part in shapely.get_parts(geom):
        s = (shapely.get_coordinates(part) - a) @ d
        if len(s) and s.max() - s.min() > 0.05:
            out.append([round(float(max(s.min(), 0)), 2), round(float(min(s.max(), length)), 2)])
    return sorted(out)


def storeys(height, floors):
    return floors or max(round(height / sims.STOREY_M), 1)


@router.get("")
def section(lon: Lon, lat: Lat, heading: Heading, length: Length = 300):
    a, b, d, n, strip = frame(lon, lat, heading, length)
    line = shapely.LineString([a, b])
    found = rows("""
        WITH q AS (SELECT ST_GeomFromWKB(%s, 6677) AS strip, ST_GeomFromWKB(%s, 6677) AS line)
        SELECT g.gml_id, g.usage, g.floors, g.height, ST_AsBinary(c.part) AS part, ST_AsBinary(c.cut) AS cut,
               ST_AsGeoJSON(ST_Transform(c.part, 4326), 7)::json AS outline,
               ST_X(ST_Transform(ST_PointOnSurface(c.part), 4326)) AS lon,
               ST_Y(ST_Transform(ST_PointOnSurface(c.part), 4326)) AS lat
        FROM q JOIN buildings g ON ST_Intersects(g.footprint_geometry, q.strip)
        CROSS JOIN LATERAL (SELECT
            ST_CollectionExtract(ST_Intersection(g.footprint_geometry, q.strip), 3) AS part,
            ST_CollectionExtract(ST_Intersection(g.footprint_geometry, q.line), 2) AS cut) c
        WHERE NOT ST_IsEmpty(c.part) AND coalesce(g.height, g.floors * %s) IS NOT NULL""",
                 (strip.wkb, line.wkb, sims.STOREY_M))
    cut, behind = [], []
    for f in found:
        height = f["height"] or f["floors"] * sims.STOREY_M
        coords = shapely.get_coordinates(shapely.from_wkb(bytes(f["part"]))) - a
        along, depth = coords @ d, coords @ n
        hit = spans(shapely.from_wkb(bytes(f["cut"])), a, d, length)
        item = {"gml_id": f["gml_id"], "usage": f["usage"], "height": height, "floors": storeys(height, f["floors"]),
                "floors_known": f["floors"] is not None,
                "span": [round(float(max(along.min(), 0)), 2), round(float(min(along.max(), length)), 2)]}
        if hit:
            cut.append({**item, "cut": hit, "outline": f["outline"], "lon": f["lon"], "lat": f["lat"]})
        else:
            behind.append({**item, "depth": round(float(depth.min()), 1)})
    lons, lats, ends = line_points(a, b, length)
    behind.sort(key=lambda x: -x["depth"])  # farthest first, so nearer ones are drawn over them
    return {"length": length, "step": STEP_M, "ends": ends, "ground": ground(lons, lats), "cut": cut, "behind": behind,
            "behind_m": BEHIND_M,
            "method": "Outlines, heights and floor counts: PLATEAU. Ground: GSI 5 m elevation model. "
                      "Floors are the height divided evenly, so they are schematic, not surveyed interiors."}


@router.get("/flood")
def section_flood(breach_id: str, lon: Lon, lat: Lat, heading: Heading, length: Length = 300):
    """Along the cut: when 0.5 m arrives in this scenario, and the depth class it peaks in."""
    r = sims.flood(breach_id)
    a, b, *_ = frame(lon, lat, heading, length)
    lons, lats, _ = line_points(a, b, length)
    first, deepest = sims.flooded_from(r, lons, lats), sims.sample(r, "deepest", lons, lats).tolist()
    wet = [m is not None and k >= sims.IMPASSABLE for m, k in zip(first, deepest)]
    return {"arrives": [m if w else None for m, w in zip(first, wet)],
            "low": [CLASS_LOW[k] if w else 0 for k, w in zip(deepest, wet)],
            "high": [sims.CLASS_TOP[k] if w else 0 for k, w in zip(deepest, wet)],
            "note": "GSI publishes depth as classes. The band is the class this scenario peaks in, "
                    "shown from the step when 0.5 m arrives."}


@router.get("/plan")
def plan(height: Annotated[float, Query(ge=0, le=300)]):
    """What a horizontal cut at this height above ground passes through."""
    r = row("""SELECT count(*) AS buildings, coalesce(sum(ST_Area(footprint_geometry)), 0) AS area_m2
               FROM buildings WHERE height > %s""", (height,))
    if r is None:
        raise HTTPException(503, "Buildings not ingested yet.")
    return r


if __name__ == "__main__":
    px = np.array([[[0, 39, 16], [128, 0, 0], [255, 255, 156]]], np.uint8)  # 100.00 m, no data, -1.00 m
    z = decode_dem(px)[0]
    assert abs(z[0] - 100) < 1e-6 and np.isnan(z[1]) and abs(z[2] + 1) < 1e-6, z
    assert storeys(10, None) == 3 and storeys(10, 5) == 5
    d = np.array([1.0, 0.0])
    assert spans(shapely.MultiLineString([[(2, 0), (4, 0)], [(8, 0), (20, 0)]]), np.zeros(2), d, 10) == [[2, 4], [8, 10]]
