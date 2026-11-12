"""Rooftop solar resource per building: yearly sunshine on the roof after shading by other buildings.

Method, all on a 2 m grid of building heights (PLATEAU measured height, flat roofs):
- NASA POWER gives the monthly average sunshine on open horizontal ground, split into the part
  that comes straight from the sun (direct) and the part from the whole sky (diffuse).
- For the 15th of each month the sun is placed once per hour of solar time. A roof cell is in
  shadow when a taller building stands between it and the sun.
- Each month's direct part is shared over its hours in proportion to the sine of the sun's
  elevation and counted only for the hours a cell is lit. The diffuse part is counted in full.

Run: python -m ingestion.ingest_solar      (after ingest_citygml; takes a few minutes)
"""
import json
import math
import os
import urllib.request
from datetime import datetime, timezone

import numpy as np
import psycopg
import shapely
from PIL import Image, ImageDraw
from psycopg.types.json import Jsonb

from .discover_plateau import AOI, DATA
from .ingest_network import SCHEMA, UA

POWER = ("https://power.larc.nasa.gov/api/temporal/climatology/point?parameters=ALLSKY_SFC_SW_DWN,ALLSKY_SFC_SW_DIFF"
         "&community=RE&longitude={lon}&latitude={lat}&format=JSON")
CELL = 2.0  # metres
# ponytail: shadows are followed for 400 m. Only towers over ~70 m throw longer ones at the
# lowest sun counted (10 degrees); raise this if the AOI gains a cluster of high-rises.
REACH = 400.0
MIN_ELEVATION = 10.0  # degrees; lower sun carries little energy and is mostly hidden in a city
MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]
DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]


def sun(lat, day_of_year, solar_hour):
    """(elevation, azimuth) in degrees; azimuth clockwise from north. Solar time, so noon is due south."""
    phi = math.radians(lat)
    dec = math.radians(23.44) * math.sin(2 * math.pi * (284 + day_of_year) / 365)
    h = math.radians(15 * (solar_hour - 12))
    el = math.asin(math.sin(phi) * math.sin(dec) + math.cos(phi) * math.cos(dec) * math.cos(h))
    az = math.atan2(math.sin(h), math.cos(h) * math.sin(phi) - math.tan(dec) * math.cos(phi)) + math.pi
    return math.degrees(el), math.degrees(az) % 360


def shifted(a, dx, dy):
    """`a` moved so that out[row, col] = a[row + dy, col + dx]; cells from outside the grid are 0."""
    out = np.zeros_like(a)
    h, w = a.shape
    ys, yd = (slice(dy, h), slice(0, h - dy)) if dy >= 0 else (slice(0, h + dy), slice(-dy, h))
    xs, xd = (slice(dx, w), slice(0, w - dx)) if dx >= 0 else (slice(0, w + dx), slice(-dx, w))
    out[yd, xd] = a[ys, xs]
    return out


def shadow(height, el, az):
    """True where the cell's own surface is shaded. Rows run south, columns east."""
    tan, east, north = math.tan(math.radians(el)), math.sin(math.radians(az)), math.cos(math.radians(az))
    shaded = np.zeros(height.shape, bool)
    top = float(height.max())
    for k in range(1, int(min(REACH, top / tan) / CELL) + 1):
        drop = k * CELL * tan  # how far the sun ray has risen over this distance
        blocker = shifted(height, round(k * east), -round(k * north))
        shaded |= blocker - drop > height + 0.5
    return shaded


def main():
    lon, lat = (AOI[0] + AOI[2]) / 2, (AOI[1] + AOI[3]) / 2
    path = DATA / f"nasa_power_{lon:.3f}_{lat:.3f}.json"
    if not path.exists():
        with urllib.request.urlopen(urllib.request.Request(POWER.format(lon=lon, lat=lat), headers=UA), timeout=120) as r:
            path.write_bytes(r.read())
    power = json.loads(path.read_text())
    total, diffuse = (power["properties"]["parameter"][k] for k in ("ALLSKY_SFC_SW_DWN", "ALLSKY_SFC_SW_DIFF"))

    with psycopg.connect(os.environ["DATABASE_URL"]) as conn, conn.cursor() as cur:
        cur.execute(SCHEMA.read_text())
        cur.execute("SELECT id, coalesce(height, 3 * floors, 6), ST_AsBinary(footprint_geometry) FROM buildings ORDER BY 2")
        blds = cur.fetchall()  # lowest first, so a taller building wins where footprints overlap
        geoms = shapely.from_wkb([b[2] for b in blds])
        x0, y0, x1, y1 = shapely.total_bounds(geoms)
        w, h = math.ceil((x1 - x0) / CELL), math.ceil((y1 - y0) / CELL)
        height_img, owner_img = Image.new("F", (w, h), 0.0), Image.new("I", (w, h), 0)
        for n, (b, g) in enumerate(zip(blds, geoms), start=1):
            for poly in g.geoms:
                ring = [((x - x0) / CELL, (y1 - y) / CELL) for x, y in poly.exterior.coords]
                ImageDraw.Draw(height_img).polygon(ring, fill=float(b[1]))
                ImageDraw.Draw(owner_img).polygon(ring, fill=n)
        height, owner = np.asarray(height_img), np.asarray(owner_img)

        open_sky = sum(d * total[m] for d, m in zip(DAYS, MONTHS))
        received = np.full(height.shape, sum(d * diffuse[m] for d, m in zip(DAYS, MONTHS)), np.float32)
        for i, (month, days) in enumerate(zip(MONTHS, DAYS)):
            hours = [sun(lat, sum(DAYS[:i]) + 15, t) for t in np.arange(4.5, 20, 1.0)]
            hours = [(el, az) for el, az in hours if el > 0]
            share = sum(math.sin(math.radians(el)) for el, _ in hours)
            direct = days * (total[month] - diffuse[month])
            for el, az in hours:
                weight = direct * math.sin(math.radians(el)) / share
                # Sun below the cut-off counts as hidden everywhere.
                if el >= MIN_ELEVATION:
                    received += weight * ~shadow(height, el, az)
            print(f"{month}: {len(hours)} sun positions done", flush=True)

        cells = np.bincount(owner.ravel(), minlength=len(blds) + 1)
        mean = np.bincount(owner.ravel(), weights=received.ravel(), minlength=len(blds) + 1) / np.maximum(cells, 1)
        cur.execute("""INSERT INTO data_sources (provider, dataset_name, dataset_year, source_url, license_url,
                           downloaded_at, metadata_json) VALUES (%s, %s, %s, %s, %s, %s, %s)
                       ON CONFLICT (provider, dataset_name) DO UPDATE SET (downloaded_at, metadata_json) =
                           (EXCLUDED.downloaded_at, EXCLUDED.metadata_json)""",
                    ("NASA POWER", "Solar irradiance climatology (SYN1deg)", 2025, "https://power.larc.nasa.gov/",
                     "https://power.larc.nasa.gov/docs/referencing/", datetime.now(timezone.utc),
                     Jsonb({"point": [lon, lat], "period": power["header"]["range"], "open_sky_kwh_m2_year": open_sky,
                            "units": "kWh/m2/day on the horizontal, monthly means", "cell_m": CELL, "reach_m": REACH,
                            "min_sun_elevation_deg": MIN_ELEVATION})))
        cur.execute("TRUNCATE building_solar")
        with cur.copy("COPY building_solar (building_id, roof_cells, irradiation_kwh_m2, open_sky_kwh_m2) FROM STDIN") as copy:
            for n, b in enumerate(blds, start=1):
                if cells[n]:  # footprints thinner than a cell are skipped
                    copy.write_row((b[0], int(cells[n]), float(mean[n]), open_sky))
        got = mean[1:][cells[1:] > 0]
        print(f"open sky {open_sky:.0f} kWh/m2/yr; {len(got)} of {len(blds)} buildings; "
              f"roof median {np.median(got):.0f}, 5th percentile {np.percentile(got, 5):.0f}, min {got.min():.0f}")


def demo():
    el, az = sun(35.7, 172, 12)  # midsummer noon: due south, 90 - latitude + 23.44
    assert abs(el - 77.74) < 0.3 and abs(az - 180) < 0.01, (el, az)
    assert sun(35.7, 172, 8)[1] < 180 < sun(35.7, 172, 16)[1]  # morning sun in the east
    # A 20 m block due south of a flat roof: with the sun at 45 degrees it shades 20 m to its north.
    grid = np.zeros((40, 40), np.float32)
    grid[30:34, 18:22] = 20
    s = shadow(grid, 45, 180)
    assert s[25, 20] and s[21, 20] and not s[18, 20] and not s[36, 20] and not s[31, 20]


if __name__ == "__main__":
    demo()
    main()
