// CesiumJS scene: PLATEAU terrain + buildings, road and static hazard ground layers,
// and the time-dependent GSI flood raster.
import * as Cesium from "cesium";
import { api, type Json, type Point } from "./api";
import { createWater, gsiStep, shade, zoneStep } from "./water";

export type LayerId = "buildings" | "roads" | "hazards" | "flood";
export type ZoneType = "storm_surge" | "earthquake_shaking";
export interface Pick {
  isBuilding: boolean;
  gmlId: string | null;
  point: Point | null;
}

// Light to dark by source rank code (1 = shallowest category).
const RANK_COLOURS = ["#8fd3ff", "#3b9cf5", "#2f6bff", "#3f3fd0", "#4a2a9c", "#3b1a6e"];
export const rankColour = (rank: string) => RANK_COLOURS[Math.min(Number(rank) || 1, 6) - 1];

function groundPolygons(fc: Json, colourOf: (props: Json) => Cesium.Color) {
  const ring = (r: number[][]) => Cesium.Cartesian3.fromDegreesArray(r.flat());
  const instances: Cesium.GeometryInstance[] = [];
  for (const f of fc.features) {
    const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const [outer, ...holes] of polys) {
      instances.push(
        new Cesium.GeometryInstance({
          geometry: new Cesium.PolygonGeometry({
            polygonHierarchy: new Cesium.PolygonHierarchy(
              ring(outer),
              holes.map((h: number[][]) => new Cesium.PolygonHierarchy(ring(h))),
            ),
          }),
          attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(colourOf(f.properties)) },
        }),
      );
    }
  }
  return new Cesium.GroundPrimitive({
    geometryInstances: instances,
    appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: true }),
    classificationType: Cesium.ClassificationType.TERRAIN, // drape on the ground, not on buildings
  });
}

export async function createScene(container: HTMLElement, meta: Json, onPick: (p: Pick) => void) {
  const viewer = new Cesium.Viewer(container, {
    baseLayer: new Cesium.ImageryLayer(
      new Cesium.UrlTemplateImageryProvider({
        url: "https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png",
        maximumLevel: 18,
        credit: new Cesium.Credit('<a href="https://maps.gsi.go.jp/development/ichiran.html">GSI Tiles</a>'),
      }),
    ),
    // Cesium appends layer.json itself, so it needs the directory URL.
    terrainProvider: await Cesium.CesiumTerrainProvider.fromUrl(meta.layers.terrain.replace(/\/layer\.json$/, "")),
    // Render only when something changes instead of 60 times a second.
    requestRenderMode: true,
    maximumRenderTimeChange: Infinity,
    msaaSamples: 1,
    animation: false,
    timeline: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
  });
  const scene = viewer.scene;
  scene.globe.depthTestAgainstTerrain = true;
  scene.globe.maximumScreenSpaceError = 3;
  scene.globe.baseColor = Cesium.Color.fromCssColorString("#1b1d21");
  scene.backgroundColor = Cesium.Color.fromCssColorString("#1b1d21");
  scene.skyBox = scene.sun = scene.moon = undefined as never;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
  scene.fog.enabled = false;
  // Mute the base map to a dark monochrome so buildings and flood colour carry the scene.
  const base = viewer.imageryLayers.get(0);
  base.saturation = 0;
  base.brightness = 0.32;
  base.contrast = 1.25;
  (viewer.cesiumWidget.creditContainer as HTMLElement).style.display = "none"; // credits live in the Sources panel
  const TILES: Cesium.Cesium3DTileset.ConstructorOptions = {
    maximumScreenSpaceError: 28, // coarser distant buildings: far fewer tiles in memory
    dynamicScreenSpaceError: true,
    cacheBytes: 256 * 1024 * 1024,
    maximumCacheOverflowBytes: 128 * 1024 * 1024,
  };

  // LOD2 is primary; LOD1 is the fallback if the LOD2 tileset cannot be loaded.
  let buildings: Cesium.Cesium3DTileset;
  let buildingLod = "LOD2";
  try {
    buildings = await Cesium.Cesium3DTileset.fromUrl(meta.layers.buildings_lod2, TILES);
  } catch {
    buildings = await Cesium.Cesium3DTileset.fromUrl(meta.layers.buildings_lod1, TILES);
    buildingLod = "LOD1";
  }
  viewer.scene.primitives.add(buildings);

  // Building colours are set feature by feature as tiles come into view, so a simulator can
  // colour tens of thousands of buildings by GML ID. A tile is repainted only when `paint` changes.
  const colour = (() => {
    const made = new Map<string, Cesium.Color>();
    return (css: string) => made.get(css) ?? made.set(css, Cesium.Color.fromCssColorString(css)).get(css)!;
  })();
  let tint: Map<string, string> | null = null;
  let selected: string | null = null;
  let paint = 0;
  const painted = new WeakMap<object, number>();
  buildings.tileVisible.addEventListener((tile: Cesium.Cesium3DTile) => {
    const c = tile.content;
    if (painted.get(c) === paint) return;
    painted.set(c, paint);
    for (let i = 0; i < c.featuresLength; i++) {
      const f = c.getFeature(i);
      const id = f.getProperty("gml_id");
      // With a simulator layer on, the selection is white and buildings without a value recede.
      f.color = colour(id === selected ? (tint ? "#ffffff" : "#f5a524") : tint ? (tint.get(id) ?? "#5d626b") : "#d7dade");
    }
  });
  const repaint = () => {
    paint++;
    scene.requestRender();
  };

  // Simulator overlays: evacuation flows, one route, and point markers (refuges, stops).
  let flows: Cesium.GroundPolylinePrimitive | null = null;
  let flowCloses: (number | null)[] = [];
  let flowTime = 0;
  let flowShown = NaN; // the time the visible segments were last matched to
  scene.postRender.addEventListener(() => {
    if (!flows?.ready || flowShown === flowTime) return;
    flowShown = flowTime;
    flowCloses.forEach((closes, i) => {
      flows!.getGeometryInstanceAttributes(i).show = Cesium.ShowGeometryInstanceAttribute.toValue(closes === null || closes >= flowTime);
    });
    scene.requestRender();
  });
  const route = viewer.entities.add({
    show: false,
    polyline: { width: 5, clampToGround: true, material: Cesium.Color.WHITE },
  });
  let markers: Cesium.Entity[] = [];

  // Start over the pilot AOI, looking north.
  const home = () =>
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(meta.pilot.lon, meta.pilot.lat - 0.026, 1800),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-35), roll: 0 },
    });
  home();

  const marker = viewer.entities.add({
    show: false,
    point: { pixelSize: 10, color: Cesium.Color.fromCssColorString("#f5a524"), outlineColor: Cesium.Color.WHITE,
             outlineWidth: 2, heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
             disableDepthTestDistance: Number.POSITIVE_INFINITY },
  });

  new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas).setInputAction(
    (e: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      const picked = viewer.scene.pick(e.position);
      const cart = viewer.scene.pickPosition(e.position) ?? viewer.camera.pickEllipsoid(e.position);
      const c = cart && Cesium.Cartographic.fromCartesian(cart);
      onPick({
        isBuilding: picked instanceof Cesium.Cesium3DTileFeature,
        gmlId: picked instanceof Cesium.Cesium3DTileFeature ? (picked.getProperty("gml_id") ?? null) : null,
        point: c ? { lon: Cesium.Math.toDegrees(c.longitude), lat: Cesium.Math.toDegrees(c.latitude) } : null,
      });
    },
    Cesium.ScreenSpaceEventType.LEFT_CLICK,
  );

  const ground: Partial<Record<LayerId, Cesium.GroundPrimitive>> = {};
  const water = createWater(viewer, meta.pilot);
  const zones: Partial<Record<ZoneType, Json>> = {};
  const breach = viewer.entities.add({
    show: false,
    point: { pixelSize: 12, color: Cesium.Color.fromCssColorString("#7dd3fc"), outlineColor: Cesium.Color.WHITE,
             outlineWidth: 2, heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
             disableDepthTestDistance: Number.POSITIVE_INFINITY },
    label: { font: "500 13px Inter Tight, sans-serif", fillColor: Cesium.Color.WHITE, showBackground: true,
             backgroundColor: Cesium.Color.fromCssColorString("#16181c").withAlpha(0.85),
             backgroundPadding: new Cesium.Cartesian2(8, 5), pixelOffset: new Cesium.Cartesian2(0, -24),
             heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
             disableDepthTestDistance: Number.POSITIVE_INFINITY },
  });
  // A fixed afternoon sun, so the water glints the same way at any time of day.
  scene.light = new Cesium.DirectionalLight({ direction: new Cesium.Cartesian3(0.35, -0.55, -0.76) });

  return {
    buildingLod,
    home,
    destroy: () => viewer.destroy(),

    /** Move the camera along its view direction by a share of its height above the ellipsoid. */
    zoom(direction: 1 | -1) {
      viewer.camera.moveForward(direction * viewer.camera.positionCartographic.height * 0.35);
      scene.requestRender();
    },

    /** Highlight one building by GML ID; the colour survives tile reloads. */
    highlight(gmlId: string | null) {
      selected = gmlId;
      repaint();
    },

    /** Colour buildings by GML ID (CSS colours), or return to the plain model with null. */
    colourBuildings(colours: Map<string, string> | null) {
      tint = colours;
      repaint();
    },

    /** Evacuation flows as [lon, lat, lon, lat, people, minute the segment closes or null]; null clears them. */
    setFlows(segments: [number, number, number, number, number, number | null][] | null) {
      if (flows) viewer.scene.groundPrimitives.remove(flows);
      flows = null;
      flowCloses = (segments ?? []).map((s) => s[5]);
      flowShown = NaN;
      if (segments?.length) {
        flows = viewer.scene.groundPrimitives.add(
          new Cesium.GroundPolylinePrimitive({
            geometryInstances: segments.map(
              ([lon1, lat1, lon2, lat2, people], id) =>
                new Cesium.GeometryInstance({
                  id,
                  geometry: new Cesium.GroundPolylineGeometry({
                    positions: Cesium.Cartesian3.fromDegreesArray([lon1, lat1, lon2, lat2]),
                    width: 1.5 + Math.sqrt(people) / 30, // thicker where more people pass
                  }),
                  attributes: {
                    color: Cesium.ColorGeometryInstanceAttribute.fromColor(Cesium.Color.fromCssColorString("#5eead4").withAlpha(0.9)),
                    show: new Cesium.ShowGeometryInstanceAttribute(true),
                  },
                }),
            ),
            appearance: new Cesium.PolylineColorAppearance(),
          }),
        );
      }
      scene.requestRender();
    },

    /** Hide the flow segments that are under water at this minute of the scenario. */
    setFlowTime(minutes: number) {
      flowTime = minutes;
      scene.requestRender();
    },

    setRoute(line: [number, number][] | null) {
      route.show = !!line;
      if (line) route.polyline!.positions = new Cesium.ConstantProperty(Cesium.Cartesian3.fromDegreesArray(line.flat()));
      scene.requestRender();
    },

    /** Replace the point markers (refuges, stops). */
    setMarkers(points: { lon: number; lat: number; colour: string; size?: number }[]) {
      markers.forEach((m) => viewer.entities.remove(m));
      markers = points.map((p) =>
        viewer.entities.add({
          position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat),
          point: { pixelSize: p.size ?? 7, color: colour(p.colour), outlineColor: Cesium.Color.BLACK, outlineWidth: 1,
                   heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                   disableDepthTestDistance: Number.POSITIVE_INFINITY },
        }),
      );
      scene.requestRender();
    },

    mark(point: Point | null) {
      marker.show = !!point;
      scene.requestRender();
      if (point) marker.position = new Cesium.ConstantPositionProperty(Cesium.Cartesian3.fromDegrees(point.lon, point.lat));
    },

    /** Roads and static hazards load from the backend the first time they are switched on. */
    async setLayer(id: LayerId, on: boolean) {
      if (id === "buildings") buildings.show = on;
      else if (id === "flood") {
        water.setVisible(on);
      } else {
        if (on && !ground[id]) {
          const fc = await api(id === "roads" ? "/roads/geojson" : "/hazards/geojson");
          ground[id] = viewer.scene.groundPrimitives.add(
            id === "roads"
              ? groundPolygons(fc, (p) => Cesium.Color.fromCssColorString(p.exposed ? "#f5a524" : "#8b9099").withAlpha(0.55))
              : groundPolygons(fc, (p) => Cesium.Color.fromCssColorString(rankColour(p.hazard_rank)).withAlpha(0.55)),
          );
        }
        if (ground[id]) ground[id]!.show = on;
      }
      scene.requestRender();
    },

    /** Show the GSI flood water for one published time step, or clear it with null. */
    setFlood(template: string | null, minutes?: number, breach?: Point) {
      water.setPalette(false);
      water
        .update(template && minutes !== undefined ? gsiStep(template, minutes, breach) : null)
        .catch((e) => console.error("water surface failed:", e));
      scene.requestRender();
    },

    /** Mark where the levee breaks in the active scenario, or hide the marker with null. */
    markBreach(point: Point | null, label = "") {
      breach.show = !!point;
      if (point) {
        breach.position = new Cesium.ConstantPositionProperty(Cesium.Cartesian3.fromDegrees(point.lon, point.lat));
        breach.label!.text = new Cesium.ConstantProperty(label);
      }
      scene.requestRender();
    },

    /** Published zones of one hazard type in the pilot area: the ranks present, highest first. */
    async loadZones(type: ZoneType) {
      zones[type] ??= await api("/hazards/geojson", { hazard_type: type });
      const labels = new Map<string, string>(
        zones[type].features.map((f: Json) => [f.properties.hazard_rank, f.properties.hazard_rank_label]),
      );
      return [...labels].map(([rank, label]) => ({ rank, label })).sort((p, q) => Number(q.rank) - Number(p.rank));
    },

    /** Show the zones of one hazard type whose rank is at least `minRank`. */
    setZones(type: ZoneType, minRank: number) {
      const quake = type === "earthquake_shaking";
      water.setPalette(quake);
      // Shaking ranks are intensity x 10 in a narrow band, so spread them over the full shade range.
      const ranks = zones[type].features.map((f: Json) => Number(f.properties.hazard_rank));
      const lo = Math.min(...ranks), span = Math.max(...ranks) - lo || 1;
      water
        .update(zoneStep(`${type}@${minRank}`, zones[type], minRank, quake ? (r) => shade(((r - lo) / span) * 5) : undefined))
        .catch((e) => console.error("water surface failed:", e));
    },
  };
}

export type Scene = Awaited<ReturnType<typeof createScene>>;
