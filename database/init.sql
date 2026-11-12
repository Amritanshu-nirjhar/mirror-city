-- Mirror City V1 schema. All geometries are stored in EPSG:6677
-- (JGD2011 / Japan Plane Rectangular CS IX, metres), the analytical CRS for Tokyo.
-- Source CRS and transformation details are recorded in data_sources.metadata_json.
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE data_sources (
  id            serial PRIMARY KEY,
  provider      text NOT NULL,
  dataset_name  text NOT NULL,
  dataset_year  int,
  source_url    text NOT NULL,
  license_url   text,
  downloaded_at timestamptz,
  checksum      text,
  metadata_json jsonb NOT NULL DEFAULT '{}',
  UNIQUE (provider, dataset_name)
);

CREATE TABLE buildings (
  id                 serial PRIMARY KEY,
  gml_id             text NOT NULL UNIQUE,
  footprint_geometry geometry(MultiPolygon, 6677) NOT NULL,
  height             double precision,
  floors             int,
  usage              text,
  construction_year  int,
  structure_type     text,
  attributes_json    jsonb NOT NULL DEFAULT '{}',
  source_id          int NOT NULL REFERENCES data_sources (id)
);
CREATE INDEX ON buildings USING gist (footprint_geometry);

CREATE TABLE roads (
  id              serial PRIMARY KEY,
  gml_id          text NOT NULL UNIQUE,
  geometry        geometry(MultiPolygon, 6677) NOT NULL,
  road_type       text,
  attributes_json jsonb NOT NULL DEFAULT '{}',
  source_id       int NOT NULL REFERENCES data_sources (id)
);
CREATE INDEX ON roads USING gist (geometry);

-- One row per connected polygon of a source flood-risk feature, so a source gml_id can repeat.
CREATE TABLE hazard_zones (
  id              serial PRIMARY KEY,
  gml_id          text NOT NULL,
  hazard_type     text NOT NULL,
  geometry        geometry(Polygon, 6677) NOT NULL,
  depth_min       double precision,
  depth_max       double precision,
  hazard_rank     text,
  attributes_json jsonb NOT NULL DEFAULT '{}',
  source_id       int NOT NULL REFERENCES data_sources (id)
);
CREATE INDEX ON hazard_zones USING gist (geometry);

CREATE TABLE building_exposure (
  building_id        int NOT NULL REFERENCES buildings (id) ON DELETE CASCADE,
  hazard_zone_id     int NOT NULL REFERENCES hazard_zones (id) ON DELETE CASCADE,
  hazard_type        text NOT NULL,
  intersection_area  double precision NOT NULL,
  overlap_percentage double precision NOT NULL,
  hazard_rank        text,
  calculated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (building_id, hazard_zone_id)
);

CREATE TABLE road_exposure (
  road_id          int NOT NULL REFERENCES roads (id) ON DELETE CASCADE,
  hazard_type      text NOT NULL,
  exposed_area     double precision NOT NULL,
  exposed_fraction double precision NOT NULL,
  calculated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (road_id, hazard_type)
);

CREATE TABLE flood_scenarios (
  id              serial PRIMARY KEY,
  gsi_breach_id   text NOT NULL UNIQUE,
  breach_name     text,
  river_name      text,
  breach_location text,
  office_code     text,
  river_code      text,
  sub_river_code  text,
  rainfall_scale  int,
  time_steps      int[],
  metadata_json   jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE api_cache (
  id            serial PRIMARY KEY,
  request_key   text NOT NULL UNIQUE,
  response_json jsonb NOT NULL,
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);

-- Display-only layers for the storm-surge animation. They cover the wider area the 3D view
-- shows around the AOI. No statistic is computed from them: exposure uses hazard_zones.
CREATE TABLE water_bodies (
  id              serial PRIMARY KEY,
  gml_id          text NOT NULL,
  name            text,
  class           text,
  geometry        geometry(MultiPolygon, 6677) NOT NULL,
  attributes_json jsonb NOT NULL DEFAULT '{}',
  source_id       int NOT NULL REFERENCES data_sources (id)
);

-- Official hazard zones dissolved to one row per rank over the display extent.
CREATE TABLE hazard_display_zones (
  id                serial PRIMARY KEY,
  hazard_type       text NOT NULL,
  hazard_name       text,
  hazard_rank       text NOT NULL,
  hazard_rank_label text,
  geometry          geometry(MultiPolygon, 6677) NOT NULL,
  source_id         int NOT NULL REFERENCES data_sources (id)
);

-- ponytail: PLATEAU LOD1 roads are surface polygons, not centrelines, so there is no
-- source road length. This estimates it as the long side of the rectangle with the same
-- area and perimeter. Upgrade path: intersect a real centreline network instead.
CREATE FUNCTION road_length_est(g geometry) RETURNS double precision
LANGUAGE sql IMMUTABLE AS $$
  SELECT (ST_Perimeter(g) + sqrt(greatest(ST_Perimeter(g) ^ 2 - 16 * ST_Area(g), 0))) / 4
$$;
