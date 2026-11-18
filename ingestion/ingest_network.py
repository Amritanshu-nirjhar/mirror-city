"""Walking network, rail stations and flood refuges for the evacuation and transit simulators.

- Streets and paths: OpenStreetMap ways over the AOI plus a margin, so routes can leave the
  pilot area. PLATEAU roads are surface polygons with no centrelines, so they cannot be routed.
- Rail stations: OpenStreetMap, location only (no open timetable covers every operator here).
- Refuges: GSI designated emergency evacuation sites for river flooding (指定緊急避難場所, 洪水).

Run: python -m ingestion.ingest_network      (after ingest_display, which loads the water bodies)
"""
import json
import math
import os
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb

from .discover_plateau import AOI, DATA

MARGIN = 0.015  # degrees, about 1.5 km: room to walk out of the pilot area
EXTENT = (AOI[0] - MARGIN, AOI[1] - MARGIN, AOI[2] + MARGIN, AOI[3] + MARGIN)  # west, south, east, north
OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter"]
REFUGE_TILES = "https://cyberjapandata.gsi.go.jp/xyz/skhb01/10/{x}/{y}.geojson"  # published at zoom 10 only
NOT_WALKABLE = {"motorway", "motorway_link", "busway", "construction", "proposed", "raceway"}
UA = {"User-Agent": "mirror-city/1.0"}
SCHEMA = Path(__file__).resolve().parent.parent / "database" / "sims.sql"


def get(url, data=None):
    with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=UA), timeout=180) as r:
        return json.load(r)


def cached(name, fetch):
    """Downloads are kept on disk so reruns do not ask the public servers again."""
    path = DATA / name
    if not path.exists():
        path.write_text(json.dumps(fetch()))
    return json.loads(path.read_text())


def overpass_query(query):
    body = urllib.parse.urlencode({"data": query}).encode()
    for attempt in range(6):  # the public servers are often at capacity: back off and alternate
        try:
            return get(OVERPASS[attempt % len(OVERPASS)], body)
        except OSError as err:
            print(f"Overpass attempt {attempt + 1} failed ({err}); retrying")
            time.sleep(10 * 2 ** attempt)
    raise SystemExit("OpenStreetMap Overpass servers unavailable. Try again later.")


def overpass():
    w, s, e, n = EXTENT
    return overpass_query(f'[out:json][timeout:120];(way["highway"]({s},{w},{n},{e});node["railway"="station"]({s},{w},{n},{e}););out geom qt;')


def walkable(tags):
    return (tags["highway"] not in NOT_WALKABLE and tags.get("foot") != "no"
            and tags.get("access") not in ("no", "private"))


def elevated(tags):
    try:
        layer = int(tags.get("layer", 0))
    except ValueError:
        layer = 0
    return tags.get("bridge", "no") != "no" or layer > 0


def refuges():
    """Every flood-designated site whose point lies inside the extent."""
    w, s, e, n = EXTENT

    def tile(lon, lat):
        r = math.radians(lat)
        return int((lon + 180) / 360 * 1024), int((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * 1024)

    (x0, y0), (x1, y1) = tile(w, n), tile(e, s)
    out = []
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            for f in get(REFUGE_TILES.format(x=x, y=y))["features"]:
                lon, lat = f["geometry"]["coordinates"][:2]
                if w <= lon <= e and s <= lat <= n:
                    out.append(f)
    return out


def source(cur, provider, name, url, licence, meta):
    cur.execute("""INSERT INTO data_sources (provider, dataset_name, dataset_year, source_url, license_url,
                       downloaded_at, metadata_json) VALUES (%s, %s, %s, %s, %s, %s, %s)
                   ON CONFLICT (provider, dataset_name) DO UPDATE SET (dataset_year, downloaded_at, metadata_json) =
                       (EXCLUDED.dataset_year, EXCLUDED.downloaded_at, EXCLUDED.metadata_json) RETURNING id""",
                (provider, name, datetime.now(timezone.utc).year, url, licence, datetime.now(timezone.utc), Jsonb(meta)))
    return cur.fetchone()[0]


def main():
    tag = "_".join(map(str, EXTENT))
    osm = cached(f"osm_{tag}.json", overpass)["elements"]
    sites = cached(f"refuges_{tag}.json", refuges)
    nodes, edges = {}, []
    for way in (el for el in osm if el["type"] == "way" and walkable(el["tags"])):
        up = elevated(way["tags"])
        for i, p in zip(way["nodes"], way["geometry"]):
            nodes[i] = (p["lon"], p["lat"])
        edges += [(a, b, up, way["tags"]["highway"]) for a, b in zip(way["nodes"], way["nodes"][1:])]
    stations = {}  # one row per station name: operators map their own node for a shared station
    for el in osm:
        if el["type"] == "node" and el["tags"].get("name"):
            stations.setdefault(el["tags"]["name"], []).append(el)

    with psycopg.connect(os.environ["DATABASE_URL"]) as conn, conn.cursor() as cur:
        cur.execute(SCHEMA.read_text())
        osm_src = source(cur, "OpenStreetMap contributors", "OpenStreetMap streets, paths and rail stations",
                         "https://www.openstreetmap.org/", "https://www.openstreetmap.org/copyright",
                         {"extent": EXTENT, "via": "Overpass API", "licence": "ODbL 1.0"})
        gsi_src = source(cur, "Geospatial Information Authority of Japan (GSI)", "指定緊急避難場所データ (洪水)",
                         "https://www.gsi.go.jp/bousaichiri/hinanbasho.html",
                         "https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html",
                         {"extent": EXTENT, "tiles": REFUGE_TILES, "hazard": "disaster1: river flooding"})
        cur.execute("TRUNCATE walk_nodes, walk_edges, refuges RESTART IDENTITY")
        cur.execute("DELETE FROM transit_stops WHERE mode = 'rail'")
        with cur.copy("COPY walk_nodes (id, lon, lat) FROM STDIN") as copy:
            for i, (lon, lat) in nodes.items():
                copy.write_row((i, lon, lat))
        with cur.copy("COPY walk_edges (a, b, elevated, highway) FROM STDIN") as copy:
            for e in edges:
                copy.write_row(e)
        # River terraces and bridges are not dry ground to flee to, whatever the flood raster shows there.
        cur.execute("""UPDATE walk_nodes n SET near_water = true FROM water_bodies w
                       WHERE ST_DWithin(w.geometry, ST_Transform(ST_SetSRID(ST_MakePoint(n.lon, n.lat), 6668), 6677), 20)""")
        near = cur.rowcount
        for f in sites:
            p, (lon, lat) = f["properties"], f["geometry"]["coordinates"][:2]
            cur.execute("INSERT INTO refuges (name, address, remarks, lon, lat, source_id) VALUES (%s, %s, %s, %s, %s, %s)",
                        (p["name"], p.get("address"), p.get("remarks") or None, lon, lat, gsi_src))
        for name, els in stations.items():
            ops = sorted({el["tags"]["operator"] for el in els if el["tags"].get("operator")})
            cur.execute("""INSERT INTO transit_stops (stop_id, name, mode, operator, lon, lat, source_id)
                           VALUES (%s, %s, 'rail', %s, %s, %s, %s)""",
                        (f"osm:{els[0]['id']}", name, " / ".join(ops) or None,
                         sum(el["lon"] for el in els) / len(els), sum(el["lat"] for el in els) / len(els), osm_src))
        print(f"walk network: {len(nodes)} nodes ({near} beside water), {len(edges)} edges, "
              f"{sum(e[2] for e in edges)} elevated; {len(stations)} rail stations; {len(sites)} flood refuges")


if __name__ == "__main__":
    assert elevated({"bridge": "yes"}) and elevated({"layer": "1"}) and not elevated({"layer": "-1", "tunnel": "yes"})
    assert walkable({"highway": "footway"}) and not walkable({"highway": "motorway"})
    assert not walkable({"highway": "residential", "foot": "no"})
    main()
