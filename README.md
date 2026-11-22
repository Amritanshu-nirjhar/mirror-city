# Mirror City — Sumida

A 3D digital twin of Sumida ward, Tokyo, built entirely from open public data. It shows every building, the official flood and earthquake hazard, and runs four simulations on top: river flood, evacuation, transit access and rooftop solar.

Live: https://mirror-city-delta.vercel.app

Nothing here is a live sensor feed or a forecast. Every number traces back to a published dataset listed below.

## Source data

| What | Provider | Dataset / endpoint | Used for | Licence |
|---|---|---|---|---|
| Buildings, roads, water bodies, flood & storm-surge zones | MLIT Project PLATEAU | Sumida (13107) CityGML 2025, via the [PLATEAU data catalogue](https://api.plateauview.mlit.go.jp/datacatalog/plateau-datasets) | Building footprints, height, floors, use, year, structure; static hazard exposure | [PLATEAU site policy](https://www.mlit.go.jp/plateau/site-policy/) (CC BY 4.0 compatible) |
| PLATEAU 3D Tiles and terrain | MLIT Project PLATEAU | Catalogue tilesets, [terrain](https://tile.plateauview.mlit.go.jp/terrain/layer.json) | 3D buildings drawn in the browser, simulation colouring | PLATEAU site policy |
| River-flood breach scenarios | Geospatial Information Authority of Japan (GSI) | 浸水ナビ / [Inundation Navi API](https://suiboumap.gsi.go.jp/) (breach points, depth tiles, hydrographs) | Flood scenarios and the time-stepped water simulation | [GSI terms](https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html) |
| Ground height | GSI | 5 m DEM tiles (`dem5a_png`) | Section cuts, flood field | GSI terms |
| Aerial photos | GSI | Seamless photo tiles (`seamlessphoto`) | Roof textures (`public/roofs-*.webp`) | GSI terms |
| Base map | GSI | Pale map tiles (`pale`) | Map background | GSI terms |
| Evacuation refuges | GSI | 指定緊急避難場所データ (洪水), `skhb01` tiles | Evacuation destinations | GSI terms |
| Earthquake shaking | NIED J-SHIS | [Probabilistic seismic hazard map](https://www.j-shis.bosai.go.jp/) Y2024, 250 m mesh, `T30_P03_SI` | Earthquake shaking zones (intensity with 3% chance of exceedance in 30 years) | [J-SHIS agreement](https://www.j-shis.bosai.go.jp/agreement) |
| Streets, paths, rail stations, amenities | OpenStreetMap contributors | Overpass API | Walking network for evacuation and transit; amenities for Residences | [ODbL 1.0](https://www.openstreetmap.org/copyright) |
| Bus stops and timetables | Toei (Tokyo Metropolitan Bureau of Transportation) via ODPT | [Toei Bus GTFS-JP](https://ckan.odpt.org/dataset/b_bus_gtfs_jp-toei) | Transit simulation (weekday service levels) | ODPT open data terms |
| Sunshine | NASA POWER | [Climatology API](https://power.larc.nasa.gov/) `ALLSKY_SFC_SW_DWN`, `ALLSKY_SFC_SW_DIFF` | Rooftop solar simulation | [NASA POWER referencing](https://power.larc.nasa.gov/docs/referencing/) |
| Land prices | MLIT 国土数値情報 | [L01 official land price survey 2025](https://nlftp.mlit.go.jp/ksj/gml/data/L01/L01-25/L01-25_13_GML.zip) (Tokyo) | Residences price estimates | 国土数値情報 terms (CC BY 4.0 compatible) |
| Photorealistic city | Google, via Cesium ion | Photorealistic 3D Tiles | Realistic view only (display, never analysed) | Google Maps Platform terms; Google attribution must stay on screen |

Raw downloads are cached in `data/`. Each ingestion run records its provider, URL, licence and checksum in the `data_sources` table, and the app shows them with a "terms" link.

**Caveats**
- Flood scenarios are GSI's published hypothetical breaches, not a prediction.
- Rail stations have locations only; only Toei publishes an open timetable here.
- No home listings exist in open data. Residences prices are labelled estimates from land prices.
- Solar assumes flat roofs at PLATEAU's measured height.

## How it fits together

```
ingestion/ (Python)  ──►  Postgres + PostGIS  ──►  server/app (FastAPI, /api)  ──►  src/ (React + CesiumJS)
       │                                                                              ▲
       └──► public/ baked files (flood-field, roofs, estate.json) ────────────────────┘
```

- **Front end**: Vite, React 19, TypeScript, CesiumJS. Simulation answers are cached in the browser (memory + Cache Storage, one day).
- **API**: FastAPI, deployed on Vercel from `api/index.py`.
- **Database**: Neon Postgres with PostGIS (`database/init.sql`, `database/sims.sql`).

## Run locally

```sh
cp .env.example .env            # fill VITE_CESIUM_ION_TOKEN for the realistic view
docker compose up -d db         # Postgres + PostGIS

# load data (order matters)
python -m ingestion.discover_plateau
python -m ingestion.ingest_citygml
python -m ingestion.ingest_jshis
python -m ingestion.ingest_display
python -m ingestion.ingest_network
python -m ingestion.ingest_transit
python -m ingestion.ingest_solar
python -m ingestion.build_estate
python -m ingestion.build_flood_field
python -m ingestion.build_roofs

uvicorn server.app.main:app --port 8000   # API
npm install && npm run dev                 # front end
```

The study area defaults to Sumida (`PLATEAU_CITY_CODE=13107`) and the box set by `AOI_WEST/SOUTH/EAST/NORTH` in `.env`.

## Attribution

Contains data from MLIT Project PLATEAU, the Geospatial Information Authority of Japan, NIED J-SHIS, ODPT / Toei, NASA POWER, and © OpenStreetMap contributors. Realistic imagery © Google.
