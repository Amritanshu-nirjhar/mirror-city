-- Tables for the simulators (evacuation, transit, solar). Idempotent: the ingestion jobs run
-- this file, so a database created before the simulators existed is upgraded in place.

-- Walking network from OpenStreetMap: one edge per pair of consecutive way nodes.
CREATE TABLE IF NOT EXISTS walk_nodes (
  id         bigint PRIMARY KEY,
  lon        double precision NOT NULL,
  lat        double precision NOT NULL,
  near_water boolean NOT NULL DEFAULT false   -- within 20 m of a PLATEAU water body
);
CREATE TABLE IF NOT EXISTS walk_edges (
  a        bigint NOT NULL,
  b        bigint NOT NULL,
  elevated boolean NOT NULL,                  -- bridge or raised walkway: ground flooding does not close it
  highway  text
);

-- Designated emergency evacuation sites for river flooding (GSI 指定緊急避難場所, 洪水).
CREATE TABLE IF NOT EXISTS refuges (
  id        serial PRIMARY KEY,
  name      text NOT NULL,
  address   text,
  remarks   text,
  lon       double precision NOT NULL,
  lat       double precision NOT NULL,
  source_id int NOT NULL REFERENCES data_sources (id)
);

CREATE TABLE IF NOT EXISTS transit_stops (
  id                 serial PRIMARY KEY,
  stop_id            text NOT NULL,
  name               text NOT NULL,
  mode               text NOT NULL,           -- 'bus' (timetabled) or 'rail' (location only)
  operator           text,
  lon                double precision NOT NULL,
  lat                double precision NOT NULL,
  weekday_departures int,                     -- NULL where no open timetable exists
  daytime_per_hour   double precision,        -- weekday departures 07:00-19:00, per hour
  routes             text[],
  source_id          int NOT NULL REFERENCES data_sources (id)
);

CREATE TABLE IF NOT EXISTS building_solar (
  building_id        int PRIMARY KEY REFERENCES buildings (id) ON DELETE CASCADE,
  roof_cells         int NOT NULL,              -- 2 m grid cells of the footprint that were sampled
  irradiation_kwh_m2 double precision NOT NULL, -- yearly, on the horizontal, after shading by other buildings
  open_sky_kwh_m2    double precision NOT NULL, -- the same with nothing in the way
  calculated_at      timestamptz NOT NULL DEFAULT now()
);
