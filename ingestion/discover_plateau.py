"""Phase 1: resolve the PLATEAU dataset from the official catalogue and write data/manifest.json.

Run: python -m ingestion.discover_plateau
"""
import json
import os
import ssl
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

CATALOGUE = "https://api.plateauview.mlit.go.jp/datacatalog/plateau-datasets"
TERRAIN = "https://tile.plateauview.mlit.go.jp/terrain/layer.json"
GSI_BREAKPOINT = "https://suiboumap.gsi.go.jp/shinsuimap/Api/Public/GetBreakPoint"

DATA = Path(os.environ.get("DATA_DIR", Path(__file__).resolve().parent.parent / "data"))
CITY = os.environ.get("PLATEAU_CITY_CODE", "13107")
YEAR = int(os.environ.get("PLATEAU_YEAR", "2025"))
# west, south, east, north
AOI = tuple(float(os.environ.get(k, d)) for k, d in
            [("AOI_WEST", 139.80), ("AOI_SOUTH", 35.70), ("AOI_EAST", 139.83), ("AOI_NORTH", 35.73)])


def mesh_codes(west, south, east, north):
    """Japanese 3rd-level (1 km) mesh codes covering a lon/lat box: cells are 30" x 45"."""
    eps = 1e-9
    rows = range(int(south * 120 + eps), int(north * 120 - eps) + 1)
    cols = range(int((west - 100) * 80 + eps), int((east - 100) * 80 - eps) + 1)
    return [f"{r // 80}{c // 80}{r % 80 // 10}{c % 80 // 10}{r % 10}{c % 10}" for r in rows for c in cols]


# The GSI server does not support RFC 5746 secure renegotiation, which OpenSSL 3 refuses by
# default. This allows the connection; certificate verification stays on.
TLS = ssl.create_default_context()
TLS.options |= ssl.OP_LEGACY_SERVER_CONNECT


def get_json(url):
    with urllib.request.urlopen(url, timeout=120, context=TLS) as r:
        return json.load(r)


def discover(city=CITY, year=YEAR):
    cat = get_json(CATALOGUE)
    citygml = [x for x in cat["citygml"] if x.get("city_code") == city]
    match = [x for x in citygml if x["year"] == year]
    if not match:
        sys.exit(f"PLATEAU catalogue has no CityGML for {city} in {year}. "
                 f"Published years: {sorted(x['year'] for x in citygml)}. "
                 "Set PLATEAU_YEAR explicitly; another year is never substituted silently.")
    cg = match[0]
    datasets = [x for x in cat["datasets"] if x.get("city_code") == city and x["year"] == year]

    def pick(**want):
        hits = [x for x in datasets if all(x.get(k) == v for k, v in want.items())]
        return hits[0]["url"] if hits else None

    lon, lat = (AOI[0] + AOI[2]) / 2, (AOI[1] + AOI[3]) / 2
    get_json(TERRAIN)  # fails loudly if the terrain endpoint is gone
    manifest = {
        "retrieved_at": datetime.now(timezone.utc).isoformat(),
        "catalogue_url": CATALOGUE,
        "city_code": city, "city": cg["city"], "year": year, "spec": cg.get("spec"),
        "citygml": {k: cg.get(k) for k in ("url", "file_size", "feature_types", "gspatialjp_dataset_url")},
        "tilesets": {
            # Untextured LOD2 holds every building at its best LOD up to 2 and can be colour-styled.
            "bldg_lod2": pick(type_en="bldg", lod="2", texture=False, format="3D Tiles"),
            "bldg_lod1": pick(type_en="bldg", lod="1", format="3D Tiles"),
        },
        "roads_mvt_lod1": pick(type_en="tran", lod="1", format="MVT"),
        "fld_tilesets": [{"name": x["name"], "url": x["url"]} for x in datasets if x["type_en"] == "fld"],
        "terrain": TERRAIN,
        "aoi": dict(zip(("west", "south", "east", "north"), AOI)),
        "mesh_codes": mesh_codes(*AOI),
        "gsi_coverage_test": {
            "lon": lon, "lat": lat,
            "scenario_count": len(get_json(f"{GSI_BREAKPOINT}?lon={lon}&lat={lat}")),
        },
    }
    DATA.mkdir(parents=True, exist_ok=True)
    (DATA / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    return manifest


if __name__ == "__main__":
    print(json.dumps(discover(), ensure_ascii=False, indent=2))
