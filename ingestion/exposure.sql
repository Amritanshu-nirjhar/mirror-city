-- Static exposure: intersect building footprints and road surfaces with PLATEAU flood-risk
-- polygons. Areas are in m2 because every geometry is stored in EPSG:6677.
TRUNCATE building_exposure, road_exposure;

INSERT INTO building_exposure
  (building_id, hazard_zone_id, hazard_type, intersection_area, overlap_percentage, hazard_rank)
SELECT b.id, h.id, h.hazard_type, a.area,
       100 * a.area / ST_Area(b.footprint_geometry), h.hazard_rank
FROM buildings b
JOIN hazard_zones h ON ST_Intersects(b.footprint_geometry, h.geometry)
CROSS JOIN LATERAL
  (SELECT ST_Area(ST_Intersection(b.footprint_geometry, h.geometry)) AS area) a
WHERE a.area > 0;

-- Roads: union the intersections per hazard type so overlapping zones are not double counted.
INSERT INTO road_exposure (road_id, hazard_type, exposed_area, exposed_fraction)
SELECT r.id, x.hazard_type, x.area, least(x.area / ST_Area(r.geometry), 1)
FROM roads r
JOIN LATERAL (
  SELECT h.hazard_type,
         ST_Area(ST_Union(ST_Intersection(r.geometry, h.geometry))) AS area
  FROM hazard_zones h
  WHERE ST_Intersects(r.geometry, h.geometry)
  GROUP BY h.hazard_type
) x ON x.area > 0;

ANALYZE building_exposure;
ANALYZE road_exposure;
