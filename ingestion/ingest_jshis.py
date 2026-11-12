"""Earthquake shaking for the pilot AOI from NIED J-SHIS (probabilistic seismic hazard map).

Stores one hazard zone per 250 m mesh cell as hazard type `earthquake_shaking`, kept apart
from the flood types. The value is J-SHIS's own: the JMA instrumental intensity that has a
3% probability of being exceeded in 30 years (all earthquakes, average case). It is a
long-term hazard estimate, not one earthquake and not a forecast.

Run: python -m ingestion.ingest_jshis      (after ingest_citygml, which empties hazard_zones)
"""
import json
import os
import time
import urllib.request
from datetime import datetime, timezone

import psycopg
from psycopg.types.json import Jsonb
from shapely.geometry import box, shape

from .discover_plateau import AOI, DATA
from .ingest_citygml import TO_ANALYTICAL

VERSION = "Y2024"
API = f"https://www.j-shis.bosai.go.jp/map/api/pshm/{VERSION}/AVR/TTL_MTTL/meshinfo.geojson"
MEASURE = "T30_P03_SI"
NAME = "J-SHIS 確率論的地震動予測地図"
# 250 m mesh: a 3rd-level mesh (45" x 30") split 4 x 4.
DX, DY = 45 / 3600 / 4, 30 / 3600 / 4


def jma_class(si):
    """JMA seismic intensity class for an instrumental intensity."""
    for floor, name in ((6.5, "7"), (6.0, "6 Upper"), (5.5, "6 Lower"), (5.0, "5 Upper"), (4.5, "5 Lower")):
        if si >= floor:
            return name
    return str(max(round(si), 0))


def cell_centres():
    west, south, east, north = AOI
    x = (west // DX) * DX + DX / 2
    while x < east:
        y = (south // DY) * DY + DY / 2
        while y < north:
            yield x, y
            y += DY
        x += DX


def fetch_cells():
    """One request per mesh cell (the API takes one cell at a time), kept on disk for reruns."""
    path = DATA / f"jshis_{VERSION}_{'_'.join(map(str, AOI))}.json"
    if path.exists():
        return json.loads(path.read_text())
    cells = {}
    for lon, lat in cell_centres():
        with urllib.request.urlopen(f"{API}?position={lon:.6f},{lat:.6f}&epsg=4326", timeout=30) as r:
            body = json.load(r)
        if body.get("status") != "Success":
            raise SystemExit(f"J-SHIS returned no data at {lon},{lat}: {body.get('error')}")
        f = body["features"][0]
        cells[f["properties"]["meshcode"]] = f
        time.sleep(0.2)  # ponytail: sequential and polite, ~1 min for the pilot AOI; batch if the AOI grows
    path.write_text(json.dumps(cells))
    return cells


def main():
    cells = fetch_cells()
    aoi = box(*AOI)
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn, conn.cursor() as cur:
        cur.execute("""INSERT INTO data_sources (provider, dataset_name, dataset_year, source_url, license_url,
                           downloaded_at, metadata_json) VALUES (%s, %s, %s, %s, %s, %s, %s)
                       ON CONFLICT (provider, dataset_name) DO UPDATE SET
                           (dataset_year, downloaded_at, metadata_json) =
                           (EXCLUDED.dataset_year, EXCLUDED.downloaded_at, EXCLUDED.metadata_json)
                       RETURNING id""",
                    ("NIED J-SHIS (地震ハザードステーション)", NAME, int(VERSION[1:]),
                     "https://www.j-shis.bosai.go.jp/", "https://www.j-shis.bosai.go.jp/agreement",
                     datetime.now(timezone.utc),
                     Jsonb({"api": API, "measure": f"{MEASURE}: JMA instrumental intensity with a 3% probability of "
                                                   "exceedance in 30 years; all earthquakes, average case",
                            "note": "Probabilistic long-term hazard, not a single earthquake or a forecast. "
                                    "Cell outlines are WGS84 as served, treated as JGD2011 (centimetre difference)."})))
        src = cur.fetchone()[0]
        cur.execute("DELETE FROM hazard_zones WHERE hazard_type = 'earthquake_shaking'")
        n = 0
        for code, f in cells.items():
            part = shape(f["geometry"]).intersection(aoi)
            if part.geom_type != "Polygon" or part.is_empty:
                continue
            si = float(f["properties"][MEASURE])
            attrs = {**f["properties"], "gml:name": NAME, "measure": MEASURE,
                     "hazard_rank_label": f"{si:.1f} (JMA {jma_class(si)})"}
            # Rank is the published intensity x 10, so ranks sort like the values.
            cur.execute(f"""INSERT INTO hazard_zones (gml_id, hazard_type, geometry, hazard_rank, attributes_json, source_id)
                            VALUES (%s, 'earthquake_shaking', {TO_ANALYTICAL}, %s, %s, %s)""",
                        (code, part.wkb, str(round(si * 10)), Jsonb(attrs), src))
            n += 1
        cur.execute("""SELECT hazard_rank, count(*) FROM hazard_zones WHERE hazard_type = 'earthquake_shaking'
                       GROUP BY 1 ORDER BY 1""")
        print(f"earthquake_shaking: {n} cells; intensity x10 -> cells:", cur.fetchall())


if __name__ == "__main__":
    assert [jma_class(v) for v in (6.6, 6.5, 6.4, 5.5, 4.9, 3.2)] == ["7", "7", "6 Upper", "6 Lower", "5 Lower", "3"]
    main()
