"""Build public/estate.json, the real-data file behind the Residences experience.

Apartment buildings: PLATEAU. Land prices: MLIT official land price survey 2025 (国土数値情報 L01).
Amenities: OpenStreetMap. Walking times: the OpenStreetMap walking network. No listings exist in
open data, so nothing here is a home for sale; the page derives clearly labelled estimates.

Run: python -m ingestion.build_estate      (after ingest_citygml and ingest_network)
"""
import json
import math
import re
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

import numpy as np

from server.app import sims
from server.app.db import rows

from .discover_plateau import DATA
from .ingest_network import EXTENT, UA, cached, overpass_query

OUT = Path(__file__).resolve().parent.parent / "public" / "estate.json"
LAND_ZIP = "https://nlftp.mlit.go.jp/ksj/gml/data/L01/L01-25/L01-25_13_GML.zip"
CATALOGUE = "https://api.plateauview.mlit.go.jp/datacatalog/plateau-datasets"
NEIGHBOURS = ("13101", "13102", "13106", "13108", "13118", "13121", "13122", "13123")  # wards around Sumida, for the skyline
MIN_FLOORS, MIN_FOOTPRINT = 3, 120  # below this a footprint is a tower fragment or too small for flats
CATEGORIES = {
    "stations": ("Stations", None),
    "groceries": ("Groceries", '["shop"~"^(supermarket|greengrocer)$"]'),
    "schools": ("Schools", '["amenity"~"^(school|kindergarten)$"]'),
    "health": ("Healthcare", '["amenity"~"^(hospital|clinic|doctors)$"]'),
    "parks": ("Parks", '["leisure"~"^(park|garden)$"]'),
    "wellness": ("Pools & baths", '["leisure"~"^(swimming_pool|sports_centre|fitness_centre)$"]'),
    "cafes": ("Cafés", '["amenity"="cafe"]'),
    "culture": ("Culture", '["tourism"~"^(museum|gallery)$"]'),
}
BATHS = '["amenity"="public_bath"]'  # Sumida's sento count as baths
AREAS = {"本所": "Honjo", "太平": "Taihei", "京島": "Kyojima", "横川": "Yokokawa", "吾妻橋": "Azumabashi", "東向島": "Higashi-Mukojima",
         "向島": "Mukojima", "押上": "Oshiage", "業平": "Narihira", "東駒形": "Higashi-Komagata", "石原": "Ishiwara", "錦糸": "Kinshi",
         "亀沢": "Kamezawa", "緑": "Midori", "立川": "Tatekawa", "菊川": "Kikukawa", "江東橋": "Kotobashi", "千歳": "Chitose",
         "両国": "Ryogoku", "横網": "Yokoami", "文花": "Bunka", "立花": "Tachibana", "東墨田": "Higashi-Sumida", "墨田": "Sumida",
         "堤通": "Tsutsumi-dori", "八広": "Yahiro"}
DIGITS = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}


def district(address):
    """'東京都墨田区京島一丁目' -> 'Kyojima 1-chome'."""
    m = re.search(r"墨田区(.+?)([一二三四五六七八九])丁目", address or "")
    name = m.group(1) if m else re.sub(r".*墨田区", "", address or "")
    return f"{AREAS.get(name, name)} {DIGITS[m.group(2)]}-chome" if m else AREAS.get(name, name) or "Sumida"


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
        return r.read()


def land_points():
    path = DATA / "L01-25_13_GML.zip"
    if not path.exists():
        path.write_bytes(get(LAND_ZIP))
    w, s, e, n = EXTENT
    g = json.load(zipfile.ZipFile(path).open("L01-25_13_GML/L01-25_13.geojson"))
    return [(f["geometry"]["coordinates"][0], f["geometry"]["coordinates"][1], f["properties"]["L01_008"])
            for f in g["features"] if w <= f["geometry"]["coordinates"][0] <= e and s <= f["geometry"]["coordinates"][1] <= n]


def tilesets():
    code = lambda x: x.get("ward_code") or x.get("city_code")
    d = cached("plateau_catalogue_wards.json", lambda: [x for x in json.loads(get(CATALOGUE))["datasets"]
                                                        if code(x) in ("13107", *NEIGHBOURS) and x.get("format") == "3D Tiles"])
    urls = [x["url"] for x in d if code(x) == "13107"]
    pick = lambda end: next(u for u in urls if u.endswith(end))
    context = {}  # the newest plain building model of each neighbouring ward
    for x in sorted((x for x in d if code(x) in NEIGHBOURS and x.get("type_en") == "bldg" and x["url"].endswith("_lod1/tileset.json")),
                    key=lambda x: x.get("year") or 0):
        context[code(x)] = x["url"]
    manifest = json.loads((DATA / "manifest.json").read_text())
    return {"buildings": pick("sumida-ku_lod2/tileset.json"), "plain": pick("sumida-ku_lod2_no_texture/tileset.json"),
            "trees": pick("SolitaryVegetationObject_3dtiles_lod3/tileset.json"), "bridges": pick("brid_3dtiles_lod2/tileset.json"),
            "terrain": manifest["terrain"], "context": list(context.values())}


def amenities():
    w, s, e, n = EXTENT
    box = f"({s},{w},{n},{e})"
    parts = "".join(f"nwr{tag}{box};" for _, tag in CATEGORIES.values() if tag) + f"nwr{BATHS}{box};"
    els = cached("osm_amenities.json", lambda: overpass_query(f"[out:json][timeout:120];({parts});out center tags;"))["elements"]
    out = {k: {} for k in CATEGORIES}
    for el in els:
        t, name = el.get("tags", {}), el.get("tags", {}).get("name")
        c = el.get("center", el)
        if not name or "lat" not in c:
            continue
        key = ("groceries" if "shop" in t else "schools" if t.get("amenity") in ("school", "kindergarten")
               else "health" if t.get("amenity") in ("hospital", "clinic", "doctors") else "cafes" if t.get("amenity") == "cafe"
               else "culture" if "tourism" in t else "parks" if t.get("leisure") in ("park", "garden") else "wellness")
        out[key].setdefault(name, [t.get("name:en") or name, round(c["lon"], 6), round(c["lat"], 6)])
    out["stations"] = {r["name"]: [r["name"], round(r["lon"], 6), round(r["lat"], 6)]
                       for r in rows("SELECT name, lon, lat FROM transit_stops WHERE mode = 'rail'")}
    return {k: list(v.values()) for k, v in out.items()}


def river_depth(risk):
    """Deepest river-flood depth PLATEAU records for a building, or None. One value or a list at each level."""
    many = lambda v: v if isinstance(v, list) else [] if v is None else [v]
    found = [float(x["uro:depth"]) for r in many(risk) for x in many(r.get("uro:RiverFloodingRiskAttribute")) if x.get("uro:depth")]
    return max(found, default=None)


def main():
    homes = rows("""SELECT b.id, b.gml_id, b.height, b.floors, ST_Area(b.footprint_geometry) AS area, ST_X(p.pt) AS lon, ST_Y(p.pt) AS lat,
            b.attributes_json #>> '{bldg:address,core:Address,core:xalAddress,xAL:AddressDetails,xAL:Country,xAL:Locality,xAL:LocalityName}' AS address,
            b.attributes_json #>> '{uro:buildingDetailAttribute,uro:BuildingDetailAttribute,uro:specifiedFloorAreaRate}' AS far,
            b.attributes_json -> 'uro:bldgDisasterRiskAttribute' AS risk
        FROM buildings b CROSS JOIN LATERAL (SELECT ST_Transform(ST_PointOnSurface(b.footprint_geometry), 4326) AS pt) p
        WHERE b.usage = '共同住宅' AND b.attributes_json::text LIKE '%%東京都墨田区%%' AND b.floors >= %s AND b.height IS NOT NULL AND ST_Area(b.footprint_geometry) >= %s
        ORDER BY b.height DESC""", (MIN_FLOORS, MIN_FOOTPRINT))
    land = np.array(land_points())
    lon, lat = np.array([h["lon"] for h in homes]), np.array([h["lat"] for h in homes])
    k = math.cos(math.radians(lat.mean()))
    near = (((lon[:, None] - land[:, 0]) * k) ** 2 + (lat[:, None] - land[:, 1]) ** 2).argmin(1)
    g, pois = sims.graph(), amenities()
    node, access = sims.attach(g, lon, lat)
    walk = {}
    for key, items in pois.items():
        if not items:
            continue
        n, a = sims.attach(g, [p[1] for p in items], [p[2] for p in items])
        d, which = sims.nearest_source(g, [(int(x), float(y), i) for i, (x, y) in enumerate(zip(n, a))])
        walk[key] = (np.round((d[node] + access) / sims.STATION_WALK).astype(int), which[node])

    out = []
    for i, h in enumerate(homes):
        depth = river_depth(h["risk"])
        out.append([h["gml_id"], round(h["lon"], 6), round(h["lat"], 6), round(h["height"], 1), h["floors"], round(h["area"]),
                    district(h["address"]), int(float(h["far"] or 0)) or None, int(land[near[i], 2]), depth,
                    {c: [int(m[i]), int(w[i])] for c, (m, w) in walk.items()}])
    OUT.write_text(json.dumps({
        "fields": ["id", "lon", "lat", "height", "floors", "footprint", "district", "far", "land", "river_depth", "walk"],
        "homes": out, "tiles": tilesets(), "amenities": pois, "labels": {k: v[0] for k, v in CATEGORIES.items()},
        "land_points": len(land), "land_year": 2025,
    }, ensure_ascii=False, separators=(",", ":")))
    print(f"{len(out)} apartment buildings, {len(land)} land price points, " + ", ".join(f"{k}: {len(v)}" for k, v in pois.items()),
          f"-> {OUT.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    assert river_depth({"uro:RiverFloodingRiskAttribute": [{"uro:depth": "0.3"}, {"uro:depth": "1.2"}]}) == 1.2 and river_depth(None) is None
    assert district("東京都墨田区京島一丁目") == "Kyojima 1-chome" and district("東京都墨田区東向島三丁目") == "Higashi-Mukojima 3-chome"
    main()
