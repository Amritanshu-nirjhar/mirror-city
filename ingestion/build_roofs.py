"""Bake GSI aerial photos into two images the 3D view drapes over building roofs.

PLATEAU has photo textures for only some buildings, but every roof is in the aerial survey.
near: Sumida at about 1.3 m a pixel. wide: the surrounding wards at about 8 m a pixel.

Run: python -m ingestion.build_roofs      (writes public/roofs-*.webp and public/roofs.json)
"""
import io
import json
import math
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image

PUBLIC = Path(__file__).resolve().parent.parent / "public"
TILE = "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg"
AREAS = {"near": (17, (139.787, 35.688, 139.838, 35.737), 4096, 66), "wide": (14, (139.72, 35.62, 139.93, 35.82), 2560, 62)}


def tile_xy(lon, lat, z):
    n = 2 ** z
    return int((lon + 180) / 360 * n), int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)


def tile_edge(x, y, z):
    n = 2 ** z
    return x / n * 360 - 180, math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))


def fetch(args):
    z, x, y = args
    req = urllib.request.Request(TILE.format(z=z, x=x, y=y), headers={"User-Agent": "mirror-city/1.0"})
    for _ in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return Image.open(io.BytesIO(r.read())).convert("RGB")
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
        except OSError:
            pass
    return None


def bake(name, z, box, size, quality):
    west, south, east, north = box
    x0, y0 = tile_xy(west, north, z)
    x1, y1 = tile_xy(east, south, z)
    w, h = x1 - x0 + 1, y1 - y0 + 1
    sheet = Image.new("RGB", (w * 256, h * 256), (120, 120, 116))
    jobs = [(z, x0 + i, y0 + j) for j in range(h) for i in range(w)]
    with ThreadPoolExecutor(4) as pool:  # the same pace as one browser tab
        for (_, x, y), img in zip(jobs, pool.map(fetch, jobs)):
            if img:
                sheet.paste(img, ((x - x0) * 256, (y - y0) * 256))
    sheet.thumbnail((size, size), Image.LANCZOS)
    path = PUBLIC / f"roofs-{name}.webp"
    sheet.save(path, quality=quality, method=6)
    lon0, lat0 = tile_edge(x0, y0, z)
    lon1, lat1 = tile_edge(x1 + 1, y1 + 1, z)
    print(name, sheet.size, f"{path.stat().st_size / 1e6:.1f} MB")
    return {"url": f"/{path.name}", "west": lon0, "north": lat0, "east": lon1, "south": lat1}


if __name__ == "__main__":
    assert tile_xy(139.815, 35.715, 14) == (14555, 6449)
    west, north = tile_edge(14555, 6449, 14)
    assert west < 139.815 and north > 35.715
    (PUBLIC / "roofs.json").write_text(json.dumps({n: bake(n, *a) for n, a in AREAS.items()}))
