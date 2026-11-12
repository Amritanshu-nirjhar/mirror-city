"""Phase 2 + 4: load PLATEAU CityGML buildings, roads and flood-risk zones for the pilot
AOI into PostGIS, then compute static exposure.

Run: python -m ingestion.ingest_citygml
"""
import functools
import hashlib
import json
import os
import posixpath
import shutil
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import psycopg
import shapely
from lxml import etree
from psycopg.types.json import Jsonb
from shapely.geometry import MultiPolygon, Polygon, box

from .discover_plateau import AOI, CITY, DATA, YEAR, discover

GML = "{http://www.opengis.net/gml}"
BLDG = "{http://www.opengis.net/citygml/building/2.0}"
TRAN = "{http://www.opengis.net/citygml/transportation/2.0}"
WTR = "{http://www.opengis.net/citygml/waterbody/2.0}"
GEN = "http://www.opengis.net/citygml/generics/2.0"
# Sub-trees that are geometry or child features, not attributes of the feature itself.
SKIP = {"boundedBy", "consistsOfBuildingPart", "trafficArea", "auxiliaryTrafficArea", "outerBuildingInstallation"}
# Source CRS is EPSG:6697 (JGD2011 lat, lon, ellipsoidal height). We keep lon/lat as
# EPSG:6668 (its 2D form) and let PostGIS/PROJ transform to the analytical CRS EPSG:6677.
TO_ANALYTICAL = "ST_Transform(ST_GeomFromWKB(%s, 6668), 6677)"
CRS_NOTE = {
    "source_crs": "EPSG:6697 (JGD2011 geographic 3D, axis order lat/lon/h)",
    "storage_crs": "EPSG:6677 (JGD2011 / Japan Plane Rectangular CS IX)",
    "transformation": "heights dropped (2D analysis); PostGIS ST_Transform EPSG:6668 -> EPSG:6677",
    "aoi_clipping": "buildings kept whole when their representative point is inside the AOI; "
                    "roads and hazard zones are cut at the AOI boundary",
    "unknown_values": "PLATEAU sentinels 9999 / -9999 are stored as NULL",
}
PLATEAU_LICENSE = "https://www.mlit.go.jp/plateau/site-policy/"
GSI_LICENSE = "https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html"

AOI_BOX = box(*AOI)
AOI_NEAR = AOI_BOX.buffer(0.005)
# CityGML model -> (risk attribute, hazard type). Hazard types are stored separately and never merged.
HAZARDS = {"fld": ("uro:RiverFloodingRiskAttribute", "river_flood"),
           "htd": ("uro:HighTideRiskAttribute", "storm_surge")}
archive: zipfile.ZipFile
MANIFEST: dict


@functools.cache
def codelist(name):
    try:
        root = etree.fromstring(archive.read(f"codelists/{name}"))
    except KeyError:
        return {}
    return {d.findtext(GML + "name"): d.findtext(GML + "description") for d in root.iter(GML + "Definition")}


def to_obj(el):
    """A CityGML element as nested JSON, minus geometry. Coded values keep code and label."""
    if len(el) == 0:
        text = (el.text or "").strip()
        space = el.get("codeSpace")
        return {"code": text, "label": codelist(posixpath.basename(space)).get(text)} if space else text
    out = {}
    for c in el:
        q = etree.QName(c)
        if not isinstance(c.tag, str) or q.localname.startswith("lod") or q.localname in SKIP:
            continue
        if q.namespace == GEN:
            key, val = c.get("name"), (c.findtext(f"{{{GEN}}}value") or "").strip()
        else:
            key, val = f"{c.prefix}:{q.localname}", to_obj(c)
        if val in ("", {}):
            continue
        out[key] = val if key not in out else (out[key] if isinstance(out[key], list) else [out[key]]) + [val]
    return out


def find(obj, key):
    """First value stored under `key` anywhere in a nested attribute object."""
    if isinstance(obj, dict):
        if key in obj:
            return obj[key][0] if isinstance(obj[key], list) else obj[key]
        obj = list(obj.values())
    if isinstance(obj, list):
        return next((r for r in (find(v, key) for v in obj) if r is not None), None)
    return None


def label(v):
    return (v.get("label") or v.get("code")) if isinstance(v, dict) else v


def num(v, cast=float):
    try:
        n = cast(float(v))
    except (TypeError, ValueError):
        return None
    return None if abs(n) == 9999 else n


def polygons(elements, near_aoi=False):
    out = []
    for el in elements:
        for p in el.iter(GML + "Polygon", GML + "Triangle"):
            rings = []
            for ring in p.iter(GML + "LinearRing"):
                v = ring.findtext(GML + "posList").split()
                rings.append([(float(v[i + 1]), float(v[i])) for i in range(0, len(v) - 2, 3)])  # lat lon h
            # Wide-area models: skip surfaces that start well outside the AOI before building geometry.
            if near_aoi and rings and not AOI_NEAR.contains_properly(shapely.Point(rings[0][0])):
                continue
            if rings and len(rings[0]) >= 4:
                out.append(Polygon(rings[0], rings[1:]))
    return out


def polygon_parts(geom):
    return [p for p in shapely.get_parts(shapely.get_parts(geom)) if p.geom_type == "Polygon" and not p.is_empty]


def dissolve(polys, clip=None):
    """Union source surfaces into valid 2D polygon parts, optionally cut to a box."""
    if not polys:
        return []
    g = shapely.union_all(shapely.make_valid(polys))
    return polygon_parts(shapely.make_valid(g.intersection(clip) if clip is not None else g))


def features(kind, tag):
    """Yield (path, element) for every `tag` feature in the AOI mesh files of one model."""
    meshes = set(MANIFEST["mesh_codes"])
    meshes |= {m[:6] for m in meshes}  # some models ship per 2nd-level mesh
    for name in sorted(archive.namelist()):
        base = posixpath.basename(name)
        if name.startswith(f"udx/{kind}/") and name.endswith(".gml") and base.split("_")[0] in meshes:
            with archive.open(name) as f:
                for _, el in etree.iterparse(f, tag=tag):
                    yield name, el
                    el.clear()
                    while el.getprevious() is not None:  # free finished siblings
                        del el.getparent()[0]


def buildings():
    for _, el in features("bldg", BLDG + "Building"):
        parts = dissolve(polygons(el.iter(BLDG + "lod0FootPrint")) or polygons(el.iter(BLDG + "lod0RoofEdge")))
        if not parts or not AOI_BOX.contains(MultiPolygon(parts).representative_point()):
            continue
        a = to_obj(el)
        yield (el.get(GML + "id"), MultiPolygon(parts).wkb,
               num(find(a, "bldg:measuredHeight")), num(find(a, "bldg:storeysAboveGround"), int),
               label(find(a, "bldg:usage")), num(find(a, "bldg:yearOfConstruction"), int),
               label(find(a, "uro:buildingStructureType")), Jsonb(a))


def roads():
    for _, el in features("tran", TRAN + "Road"):
        parts = dissolve(polygons(el.iter(TRAN + "lod1MultiSurface")), clip=AOI_BOX)
        if parts:
            a = to_obj(el)
            yield el.get(GML + "id"), MultiPolygon(parts).wkb, label(find(a, "tran:function")), Jsonb(a)


def hazard_zones():
    for kind, (attribute, hazard_type) in HAZARDS.items():
        for path, el in features(kind, WTR + "WaterBody"):
            a = to_obj(el)
            if find(a, attribute) is None:
                continue
            rank = find(a, "uro:rank") or {}
            a["source_file"], a["hazard_rank_label"] = path, rank.get("label")
            for part in dissolve(polygons(el.iter(WTR + "lod1MultiSurface"), near_aoi=True), clip=AOI_BOX):
                # depth_min/depth_max stay NULL: these polygons carry a categorical rank only.
                yield el.get(GML + "id"), hazard_type, part.wkb, rank.get("code"), Jsonb(a)


def fetch_archive(url):
    path = DATA / f"{CITY}_{YEAR}_citygml.zip"
    if not path.exists():
        print(f"downloading {url}")
        with urllib.request.urlopen(url, timeout=120) as r, open(f"{path}.part", "wb") as f:
            shutil.copyfileobj(r, f, 1 << 20)
        os.replace(f"{path}.part", path)
    sha = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            sha.update(chunk)
    return path, sha.hexdigest()


def load(cur, name, sql, rows):
    n = 0
    batch = []
    for row in rows:
        batch.append(row)
        if len(batch) == 2000:
            cur.executemany(sql, batch)
            n, batch = n + len(batch), []
    cur.executemany(sql, batch)
    cur.execute(f"SELECT count(*) FROM {name}")
    print(f"{name}: parsed {n + len(batch)}, stored {cur.fetchone()[0]}")


def main():
    global archive, MANIFEST
    manifest_path = DATA / "manifest.json"
    MANIFEST = json.loads(manifest_path.read_text()) if manifest_path.exists() else discover()
    if (MANIFEST["city_code"], MANIFEST["year"]) != (CITY, YEAR):
        MANIFEST = discover()
    path, checksum = fetch_archive(MANIFEST["citygml"]["url"])
    archive = zipfile.ZipFile(path)
    downloaded = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc)

    with psycopg.connect(os.environ["DATABASE_URL"]) as conn, conn.cursor() as cur:
        cur.execute("TRUNCATE buildings, roads, hazard_zones, building_exposure, road_exposure RESTART IDENTITY")
        upsert = """INSERT INTO data_sources (provider, dataset_name, dataset_year, source_url, license_url,
                        downloaded_at, checksum, metadata_json) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (provider, dataset_name) DO UPDATE SET
                        (dataset_year, source_url, license_url, downloaded_at, checksum, metadata_json) =
                        (EXCLUDED.dataset_year, EXCLUDED.source_url, EXCLUDED.license_url,
                         EXCLUDED.downloaded_at, EXCLUDED.checksum, EXCLUDED.metadata_json)
                    RETURNING id"""
        cur.execute(upsert, ("MLIT Project PLATEAU", f"{MANIFEST['city']} ({CITY}) CityGML", YEAR,
                             MANIFEST["citygml"]["url"], PLATEAU_LICENSE, downloaded, f"sha256:{checksum}",
                             Jsonb({**MANIFEST, "crs": CRS_NOTE})))
        src = cur.fetchone()[0]
        cur.execute(upsert, ("Geospatial Information Authority of Japan (GSI)", "浸水ナビ / Inundation Navi API", None,
                             "https://suiboumap.gsi.go.jp/", GSI_LICENSE, None, None,
                             Jsonb({"note": "Hypothetical published breach scenarios, queried on demand; not a live flood feed."})))

        load(cur, "buildings", f"""INSERT INTO buildings (gml_id, footprint_geometry, height, floors, usage,
                 construction_year, structure_type, attributes_json, source_id)
                 VALUES (%s, {TO_ANALYTICAL}, %s, %s, %s, %s, %s, %s, {src}) ON CONFLICT (gml_id) DO NOTHING""", buildings())
        load(cur, "roads", f"""INSERT INTO roads (gml_id, geometry, road_type, attributes_json, source_id)
                 VALUES (%s, {TO_ANALYTICAL}, %s, %s, {src}) ON CONFLICT (gml_id) DO NOTHING""", roads())
        load(cur, "hazard_zones", f"""INSERT INTO hazard_zones (gml_id, hazard_type, geometry, hazard_rank,
                 attributes_json, source_id) VALUES (%s, %s, {TO_ANALYTICAL}, %s, %s, {src})""", hazard_zones())
        cur.execute("ANALYZE buildings; ANALYZE roads; ANALYZE hazard_zones")

        print("computing exposure")
        cur.execute((Path(__file__).parent / "exposure.sql").read_text())
        cur.execute("SELECT (SELECT count(DISTINCT building_id) FROM building_exposure), (SELECT count(*) FROM road_exposure)")
        print("exposed buildings / roads:", cur.fetchone())
    print("hazard_zones was emptied: run `python -m ingestion.ingest_jshis` to restore earthquake shaking")


if __name__ == "__main__":
    main()
