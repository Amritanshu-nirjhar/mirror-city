"""Mirror City V1 API: building attributes, static exposure and the GSI scenario proxy."""
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Literal

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from . import gsi, sims
from .db import pool, row, rows


@asynccontextmanager
async def lifespan(_):
    pool.open()
    yield
    pool.close()


app = FastAPI(title="Mirror City V1", lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=10_000)  # GeoJSON layers are megabytes of coordinates
app.include_router(sims.router)  # evacuation, transit and solar simulators

Lon = Annotated[float, Query(ge=-180, le=180)]
Lat = Annotated[float, Query(ge=-90, le=90)]

# Paths into the preserved CityGML attributes of a flood-risk zone.
RISK = "h.attributes_json #>> '{uro:floodingRiskAttribute,uro:RiverFloodingRiskAttribute,%s,label}'"
HAZARD_COLS = f"""h.attributes_json ->> 'gml:name' AS hazard_name, h.hazard_type, h.hazard_rank,
    h.attributes_json ->> 'hazard_rank_label' AS hazard_rank_label, {RISK % 'uro:scale'} AS rainfall_scale,
    {RISK % 'uro:adminType'} AS admin_type"""
SOURCE = """json_build_object('id', s.id, 'provider', s.provider, 'dataset_name', s.dataset_name,
    'dataset_year', s.dataset_year, 'source_url', s.source_url, 'license_url', s.license_url,
    'downloaded_at', s.downloaded_at, 'checksum', s.checksum) AS source"""
BUILDING = f"""SELECT b.gml_id, b.height, b.floors, b.usage, b.construction_year, b.structure_type,
    b.attributes_json AS attributes, ST_Area(b.footprint_geometry) AS footprint_area_m2,
    ST_AsGeoJSON(ST_Transform(b.footprint_geometry, 4326), 7)::json AS footprint,
    ST_X(p.pt) AS lon, ST_Y(p.pt) AS lat, {SOURCE}
  FROM buildings b JOIN data_sources s ON s.id = b.source_id
  CROSS JOIN LATERAL (SELECT ST_Transform(ST_PointOnSurface(b.footprint_geometry), 4326) AS pt) p"""
ROAD_NOTE = ("Road exposure means the mapped road surface intersects a mapped flood-risk area. "
             "It does not establish that a road is closed, unsafe or impassable.")
LENGTH_NOTE = ("PLATEAU LOD1 roads are surface polygons, not centrelines. Length is estimated from each "
               "polygon's area and perimeter; exposed length is that estimate scaled by the exposed share of area.")
STATIC_NOTE = ("Static statistics from PLATEAU flood-risk polygons (river flooding, maximum assumed rainfall). "
               "They are independent of any GSI breach scenario.")


@app.exception_handler(gsi.UpstreamError)
def upstream_failed(_, exc):
    return JSONResponse(status_code=502, content={"detail": str(exc), "upstream": "GSI Inundation Navi"})


def plateau_source():
    src = row("SELECT * FROM data_sources WHERE provider = 'MLIT Project PLATEAU'")
    if not src:
        raise HTTPException(503, "PLATEAU dataset not ingested yet. Run the ingestion job first.")
    return src


@app.get("/api/city/metadata")
def city_metadata():
    m = plateau_source()["metadata_json"]
    aoi = m["aoi"]
    sources = rows("""SELECT id, provider, dataset_name, dataset_year, source_url, license_url,
                             downloaded_at, checksum FROM data_sources ORDER BY id""")
    return {
        "city": {"name": "Sumida Ward, Tokyo", "name_ja": m["city"], "code": m["city_code"]},
        "dataset": {"provider": "MLIT Project PLATEAU", "year": m["year"], "spec": m["spec"],
                    "catalogue_retrieved_at": m["retrieved_at"]},
        "aoi": aoi,
        "pilot": {"lon": (aoi["west"] + aoi["east"]) / 2, "lat": (aoi["south"] + aoi["north"]) / 2},
        "layers": {"buildings_lod2": m["tilesets"]["bldg_lod2"], "buildings_lod1": m["tilesets"]["bldg_lod1"],
                   "terrain": m["terrain"]},
        "crs": m["crs"],
        "sources": sources,
    }


@app.get("/api/buildings")
def search_buildings(gml_id: str | None = None, lon: Lon | None = None, lat: Lat | None = None):
    """Find a building by its original GML ID, or the building at (within 3 m of) a coordinate."""
    if gml_id:
        return rows(BUILDING + " WHERE b.gml_id = %s", (gml_id,))
    if lon is None or lat is None:
        raise HTTPException(422, "Provide gml_id, or both lon and lat.")
    return rows(BUILDING + """ CROSS JOIN LATERAL
        (SELECT ST_Transform(ST_SetSRID(ST_MakePoint(%s, %s), 4326), 6677) AS q) q
        WHERE ST_DWithin(b.footprint_geometry, q.q, 3)
        ORDER BY ST_Distance(b.footprint_geometry, q.q) LIMIT 1""", (lon, lat))


@app.get("/api/buildings/{gml_id}")
def building(gml_id: str):
    found = row(BUILDING + " WHERE b.gml_id = %s", (gml_id,))
    if not found:
        raise HTTPException(404, f"No building {gml_id} in the ingested area of interest.")
    return found


@app.get("/api/buildings/{gml_id}/exposure")
def building_exposure(gml_id: str):
    b = row(f"""SELECT b.id, ST_Area(b.footprint_geometry) AS footprint_area_m2, {SOURCE}
                FROM buildings b JOIN data_sources s ON s.id = b.source_id WHERE b.gml_id = %s""", (gml_id,))
    if not b:
        raise HTTPException(404, f"No building {gml_id} in the ingested area of interest.")
    zones = rows(f"""SELECT h.gml_id AS hazard_gml_id, {HAZARD_COLS},
            e.intersection_area AS intersection_area_m2, e.overlap_percentage, e.calculated_at,
            ST_AsGeoJSON(ST_Transform(ST_Intersection(h.geometry, ST_Buffer(bb.footprint_geometry, 25)), 4326), 7)::json
                AS geometry
        FROM building_exposure e JOIN hazard_zones h ON h.id = e.hazard_zone_id
        JOIN buildings bb ON bb.id = e.building_id
        WHERE e.building_id = %s ORDER BY hazard_name, h.hazard_rank::int DESC""", (b["id"],))
    # One line per hazard source: its worst intersecting rank, in the source's own classification.
    summary = {}
    for z in zones:
        s = summary.setdefault((z["hazard_type"], z["hazard_name"]), {
            **{k: z[k] for k in ("hazard_type", "hazard_name", "hazard_rank", "hazard_rank_label",
                                 "rainfall_scale", "admin_type")},
            "intersection_area_m2": 0.0, "overlap_percentage": 0.0})
        s["intersection_area_m2"] += z["intersection_area_m2"]
        s["overlap_percentage"] = min(100.0, s["overlap_percentage"] + z["overlap_percentage"])
    return {
        "gml_id": gml_id, "flood_exposed": bool(zones), "footprint_area_m2": b["footprint_area_m2"],
        "summary": list(summary.values()), "zones": zones, "source": b["source"],
        "method": "Footprint (PLATEAU lod0) intersected with PLATEAU fld polygons in EPSG:6677. "
                  "Ranks are the source's categories; no numeric depth is derived from them.",
        "zone_geometry_note": "Zone geometry is clipped to 25 m around the footprint for display.",
    }


@app.get("/api/hazards")
def hazards():
    """Static flood-risk layers in the AOI with their source classification."""
    plateau_source()
    return {
        "layers": rows(f"""SELECT {HAZARD_COLS}, count(*) AS zone_parts, sum(ST_Area(h.geometry)) AS area_m2,
                {SOURCE} FROM hazard_zones h JOIN data_sources s ON s.id = h.source_id
            WHERE h.hazard_type IN ('river_flood', 'storm_surge')
            GROUP BY hazard_name, h.hazard_type, h.hazard_rank, hazard_rank_label, rainfall_scale, admin_type, s.id
            ORDER BY hazard_name, h.hazard_rank::int"""),
        "note": STATIC_NOTE + " Storm surge is a separate hazard type and is never merged with river flooding.",
    }


@app.get("/api/hazards/geojson")
def hazards_geojson(hazard_type: str = "river_flood", extent: Literal["aoi", "display"] = "aoi"):
    """Hazard polygons of one type for display, dissolved by source and rank (simplified to 0.5 m).

    extent=display returns the same official zones over the wider area the 3D view shows.
    It is for drawing only: every statistic uses the AOI zones.
    """
    if extent == "display":
        return {"type": "FeatureCollection", "features": rows("""SELECT 'Feature' AS type,
                json_build_object('hazard_name', hazard_name, 'hazard_rank', hazard_rank,
                                  'hazard_rank_label', hazard_rank_label) AS properties,
                ST_AsGeoJSON(ST_Transform(geometry, 4326), 6)::json AS geometry
            FROM hazard_display_zones WHERE hazard_type = %s ORDER BY hazard_rank::int""", (hazard_type,))}
    feats = rows(f"""SELECT 'Feature' AS type,
            json_build_object('hazard_name', hazard_name, 'hazard_rank', hazard_rank,
                              'hazard_rank_label', hazard_rank_label) AS properties,
            ST_AsGeoJSON(ST_Transform(ST_SimplifyPreserveTopology(geom, 0.5), 4326), 6)::json AS geometry
        FROM (SELECT {HAZARD_COLS}, (ST_Dump(ST_Union(h.geometry))).geom AS geom FROM hazard_zones h
              WHERE h.hazard_type = %s
              GROUP BY hazard_name, h.hazard_type, h.hazard_rank, hazard_rank_label, rainfall_scale, admin_type) d""", (hazard_type,))
    return {"type": "FeatureCollection", "features": feats}


@app.get("/api/water/geojson")
def water_geojson():
    """PLATEAU water bodies (rivers, canals, ponds) over the display extent, simplified to 1 m."""
    feats = rows("""SELECT 'Feature' AS type,
            json_build_object('gml_id', gml_id, 'name', name, 'class', class) AS properties,
            ST_AsGeoJSON(ST_Transform(ST_SimplifyPreserveTopology(geometry, 1.0), 4326), 6)::json AS geometry
        FROM water_bodies""")
    return {"type": "FeatureCollection", "features": feats}


@app.get("/api/roads/geojson")
def roads_geojson():
    feats = rows("""SELECT 'Feature' AS type,
            json_build_object('gml_id', r.gml_id, 'road_type', r.road_type, 'exposed', e.road_id IS NOT NULL) AS properties,
            ST_AsGeoJSON(ST_Transform(r.geometry, 4326), 6)::json AS geometry
        FROM roads r LEFT JOIN road_exposure e ON e.road_id = r.id""")
    return {"type": "FeatureCollection", "features": feats}


@app.get("/api/roads/impact")
def roads_impact():
    src = plateau_source()
    r = row("""SELECT count(*) AS road_features,
            coalesce(sum(road_length_est(r.geometry)), 0) AS total_road_length_m,
            coalesce(sum(road_length_est(r.geometry) * e.exposed_fraction), 0) AS exposed_road_length_m,
            coalesce(sum(ST_Area(r.geometry)), 0) AS total_road_area_m2,
            coalesce(sum(e.exposed_area), 0) AS exposed_road_area_m2
        FROM roads r LEFT JOIN road_exposure e ON e.road_id = r.id AND e.hazard_type = 'river_flood'""")
    total = r["total_road_length_m"]
    return {**r, "exposure_percentage": 100 * r["exposed_road_length_m"] / total if total else None,
            "hazard_type": "river_flood", "length_method": LENGTH_NOTE, "note": ROAD_NOTE,
            "source_dataset": f"{src['dataset_name']} {src['dataset_year']}"}


@app.get("/api/dashboard/impact")
def dashboard_impact():
    src = plateau_source()
    b = row("""SELECT (SELECT count(*) FROM buildings) AS total_buildings,
                      (SELECT count(DISTINCT building_id) FROM building_exposure
                       WHERE hazard_type = 'river_flood') AS exposed_buildings""")
    by_source = rows("""SELECT h.attributes_json ->> 'gml:name' AS hazard_name,
                               count(DISTINCT e.building_id) AS exposed_buildings
                        FROM building_exposure e JOIN hazard_zones h ON h.id = e.hazard_zone_id
                        WHERE e.hazard_type = 'river_flood' GROUP BY 1 ORDER BY 1""")
    return {
        "static": {
            "label": "Static flood risk (PLATEAU)", "note": STATIC_NOTE,
            "source_dataset": f"{src['dataset_name']} {src['dataset_year']}",
            "buildings": {**b, "by_source": by_source,
                          "exposed_percentage": 100 * b["exposed_buildings"] / b["total_buildings"]
                          if b["total_buildings"] else None},
            "roads": roads_impact(),
        },
        "dynamic": {
            "label": "Selected GSI scenario",
            "note": "Depth at the selected building is point-sampled from the GSI API. Area-wide counts for a "
                    "scenario come from its map tiles: see /api/evacuation/{breach_id}.",
        },
    }


@app.get("/api/flood/scenarios")
def flood_scenarios(lon: Lon, lat: Lat):
    return gsi.scenarios(round(lon, 6), round(lat, 6))


def scenario_or_404(breach_id):
    s = gsi.known_scenario(breach_id)
    if not s:
        raise HTTPException(404, "Unknown scenario. Discover scenarios for a coordinate with /api/flood/scenarios first.")
    return s


@app.get("/api/flood/scenarios/{breach_id}/hydrograph")
def flood_hydrograph(breach_id: str, lon: Lon, lat: Lat):
    scenario_or_404(breach_id)
    return gsi.hydrograph(breach_id, round(lon, 6), round(lat, 6))


@app.get("/api/flood/scenarios/{breach_id}/depth")
def flood_depth(breach_id: str, lon: Lon, lat: Lat, minutes: Annotated[int | None, Query(ge=0)] = None):
    """Depth at a published time step, or the scenario maximum when `minutes` is omitted."""
    s = scenario_or_404(breach_id)
    if minutes is not None and minutes not in s["time_steps"]:
        raise HTTPException(422, f"{minutes} is not a published time step of {s['breach_name']}.")
    return gsi.depth(breach_id, round(lon, 6), round(lat, 6), minutes)


# Serve the built frontend when it exists (Docker image / production).
dist = Path(__file__).resolve().parents[2] / "dist"
if dist.is_dir():
    app.mount("/", StaticFiles(directory=dist, html=True), name="frontend")
