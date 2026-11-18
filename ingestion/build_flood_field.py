"""Bake the worst Arakawa breach into a small grid for the browser's water simulation.

Per 15 m cell: the published GSI time step when 0.5 m arrives, GSI's peak depth class, GSI 5 m
ground height, and whether a PLATEAU building stands there.

Run: python -m ingestion.build_flood_field      (writes public/flood-field.json and .bin)
"""
import json
import math
from pathlib import Path

import numpy as np
import shapely
from PIL import Image, ImageDraw

from server.app import section, sims
from server.app.db import pool, rows

BREACH = "c049ab2e-5f18-4cf3-a858-37a2113e692d"
WEST, SOUTH, EAST, NORTH = 139.79, 35.69, 139.84, 35.74
CELL = 15.0
NEVER = 255
PUBLIC = Path(__file__).resolve().parent.parent / "public"


def encode(first, deepest):
    """(arrival step, depth class 1-6) per cell; (255, 0) where 0.5 m never arrives."""
    wet = first != sims.NEVER
    return np.where(wet, first, NEVER).astype(np.uint8), np.where(wet, np.maximum(deepest, 0) + 1, 0).astype(np.uint8)


def main():
    pool.open()
    r = sims.flood(BREACH)
    kx, ky = 111320 * math.cos(math.radians((SOUTH + NORTH) / 2)), 110574
    w, h = round((EAST - WEST) * kx / CELL), round((NORTH - SOUTH) * ky / CELL)
    lon = WEST + (np.arange(w) + 0.5) * (EAST - WEST) / w
    lat = SOUTH + (np.arange(h) + 0.5) * (NORTH - SOUTH) / h
    lons, lats = (a.ravel() for a in np.meshgrid(lon, lat))
    arrive, depth = encode(sims.sample(r, "first", lons, lats), sims.sample(r, "deepest", lons, lats))
    elev = np.clip(np.round(np.array(section.ground(lons, lats)) * 10), -127, 127).astype(np.int8)
    img = Image.new("L", (w, h), 0)
    draw = ImageDraw.Draw(img)
    found = rows("""SELECT ST_AsBinary(ST_Transform(footprint_geometry, 4326)) AS g FROM buildings
                    WHERE footprint_geometry && ST_Transform(ST_MakeEnvelope(%s, %s, %s, %s, 4326), 6677)""", (WEST, SOUTH, EAST, NORTH))
    for g in shapely.from_wkb([bytes(f["g"]) for f in found]):
        for poly in g.geoms:
            draw.polygon([((x - WEST) / (EAST - WEST) * w, (y - SOUTH) / (NORTH - SOUTH) * h) for x, y in poly.exterior.coords], fill=1)
    (PUBLIC / "flood-field.bin").write_bytes(arrive.tobytes() + depth.tobytes() + elev.tobytes() + np.asarray(img, np.uint8).tobytes())
    (PUBLIC / "flood-field.json").write_text(json.dumps({
        "w": w, "h": h, "cell": CELL, "west": WEST, "south": SOUTH, "east": EAST, "north": NORTH,
        "steps": r["steps"].tolist(), "scenario": r["name"]}, ensure_ascii=False))
    print(f"{w}x{h}: {(arrive != NEVER).mean():.0%} floods, last step {arrive[arrive != NEVER].max()}, "
          f"ground {elev.min() / 10}..{elev.max() / 10} m, building cells {np.asarray(img).mean():.0%}")


if __name__ == "__main__":
    a, d = encode(np.array([3, sims.NEVER]), np.array([1, -1]))
    assert a.tolist() == [3, 255] and d.tolist() == [2, 0]
    main()
