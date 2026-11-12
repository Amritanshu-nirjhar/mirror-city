"""Display-only layers for the storm-surge animation: PLATEAU water bodies (rivers, canals)
and the official storm-surge zones over the wider area the 3D view shows around the AOI.

Nothing here feeds a statistic. Exposure is computed from hazard_zones, which stay cut to
the AOI. These layers let the water surface cover the view instead of stopping at the AOI
boundary, and show where the rivers are.

Run: python -m ingestion.ingest_display      (after ingest_citygml)
"""
import collections
import json
import os
import zipfile

import psycopg
import shapely
from psycopg.types.json import Jsonb
from shapely.geometry import MultiPolygon, box

from . import ingest_citygml as m
from .discover_plateau import AOI, CITY, DATA, YEAR

# The frontend draws water on 4 x 4 z14 tiles (about 8 km) centred on the AOI. This margin
# covers that square for the default AOI; the source files end at the 2nd-level mesh edge.
MARGIN = 0.04  # degrees
DISPLAY = box(AOI[0] - MARGIN, AOI[1] - MARGIN, AOI[2] + MARGIN, AOI[3] + MARGIN)
SIMPLIFY = 1.5e-5  # degrees, about 1.5 m: well below the ~8 m cell of the water grid
TO_MULTI = "ST_Multi(ST_Transform(ST_GeomFromWKB(%s, 6668), 6677))"


def in_display(polys):
    return [p for p, keep in zip(polys, shapely.intersects(polys, DISPLAY)) if keep] if polys else []


def water_bodies():
    for _, el in m.features("wtr", m.WTR + "WaterBody"):
        parts = m.dissolve(in_display(m.polygons(el.iter(m.WTR + "lod1MultiSurface"))), clip=DISPLAY)
        if parts:
            a = m.to_obj(el)
            name = a.get("gml:name")
            yield (el.get(m.GML + "id"), None if name in (None, "Null") else name,
                   m.label(m.find(a, "wtr:class")), MultiPolygon(parts).wkb, Jsonb(a))


def surge_zones():
    """Official storm-surge zones over the display extent, dissolved to one geometry per rank."""
    by_rank = collections.defaultdict(list)
    labels = {}
    for _, el in m.features("htd", m.WTR + "WaterBody"):
        a = m.to_obj(el)
        rank = m.find(a, "uro:rank") or {}
        if m.find(a, "uro:HighTideRiskAttribute") is None or not rank.get("code"):
            continue
        by_rank[rank["code"]] += m.dissolve(in_display(m.polygons(el.iter(m.WTR + "lod1MultiSurface"))), clip=DISPLAY)
        labels[rank["code"]] = (a.get("gml:name"), rank.get("label"))
    for code in sorted(by_rank):
        g = shapely.simplify(shapely.union_all(by_rank[code]), SIMPLIFY, preserve_topology=True)
        parts = m.polygon_parts(shapely.make_valid(g))
        if parts:
            yield "storm_surge", labels[code][0], code, labels[code][1], MultiPolygon(parts).wkb


# The display zones, cut back to the AOI, must cover the same area per rank as the zones the
# statistics use. A mismatch means the two layers no longer show the same official data.
CHECK = """
SELECT d.hazard_rank, ST_Area(ST_Intersection(d.geometry, aoi.g)) AS shown, z.area AS analysed
FROM hazard_display_zones d
JOIN (SELECT hazard_rank, sum(ST_Area(geometry)) AS area FROM hazard_zones
      WHERE hazard_type = 'storm_surge' GROUP BY 1) z USING (hazard_rank),
     (SELECT ST_Transform(ST_Segmentize(ST_MakeEnvelope(%s, %s, %s, %s, 6668), 0.001), 6677) AS g) aoi
WHERE d.hazard_type = 'storm_surge' ORDER BY 1"""


def main():
    m.MANIFEST = json.loads((DATA / "manifest.json").read_text())
    m.archive = zipfile.ZipFile(DATA / f"{CITY}_{YEAR}_citygml.zip")
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn, conn.cursor() as cur:
        cur.execute("SELECT id FROM data_sources WHERE provider = 'MLIT Project PLATEAU'")
        src = cur.fetchone()
        if not src:
            raise SystemExit("PLATEAU dataset not ingested yet. Run ingestion.ingest_citygml first.")
        cur.execute("TRUNCATE water_bodies, hazard_display_zones RESTART IDENTITY")
        m.load(cur, "water_bodies", f"""INSERT INTO water_bodies (gml_id, name, class, geometry, attributes_json,
                 source_id) VALUES (%s, %s, %s, {TO_MULTI}, %s, {src[0]})""", water_bodies())
        m.load(cur, "hazard_display_zones", f"""INSERT INTO hazard_display_zones (hazard_type, hazard_name,
                 hazard_rank, hazard_rank_label, geometry, source_id)
                 VALUES (%s, %s, %s, %s, {TO_MULTI}, {src[0]})""", surge_zones())
        cur.execute(CHECK, AOI)
        for rank, shown, analysed in cur.fetchall():
            print(f"storm surge rank {rank}: display layer {shown / 1e6:.3f} km2 in the AOI, analysis layer {analysed / 1e6:.3f} km2")
            assert abs(shown - analysed) < max(0.02 * analysed, 2000), f"rank {rank}: display and analysis zones disagree"


if __name__ == "__main__":
    main()
