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

// Ellipsoid height of low-lying Sumida: the geoid here (about 37 m) plus a metre or so of ground.
const FLAT_GROUND = 38;

/** PLATEAU terrain, or flat ground if its server is down: a terrain outage must not take the whole map with it. */
export async function loadTerrain(url: string): Promise<Cesium.TerrainProvider> {
  try {
    return await Promise.race([
      Cesium.CesiumTerrainProvider.fromUrl(url),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), 10000)),
    ]);
  } catch (e) {
    console.warn("PLATEAU terrain unavailable, using flat ground:", e);
    return new Cesium.CustomHeightmapTerrainProvider({
      width: 16, height: 16, callback: () => new Float32Array(256).fill(FLAT_GROUND),
    });
  }
}

export type Flow = [number, number, number, number, number, number | null];

/**
 * Simulator overlays shared by the twin and the photorealistic city: evacuation flows, one route
 * and point markers (refuges, stops). Lines drape over whatever is drawn, terrain or 3D tiles.
 * `ground` is the ellipsoid height to stand markers on when there is no terrain to clamp to.
 */
export function simOverlays(viewer: Cesium.Viewer, ground: number | null) {
  const scene = viewer.scene;
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
  const colours = new Map<string, Cesium.Color>();
  const colour = (css: string) => colours.get(css) ?? colours.set(css, Cesium.Color.fromCssColorString(css)).get(css)!;
  const standing = ground === null ? Cesium.HeightReference.CLAMP_TO_GROUND : Cesium.HeightReference.NONE;

  return {
    /** Evacuation flows as [lon, lat, lon, lat, people, minute the segment closes or null]; null clears them. */
    setFlows(segments: Flow[] | null) {
      if (flows) scene.groundPrimitives.remove(flows);
      flows = null;
      flowCloses = (segments ?? []).map((s) => s[5]);
      flowShown = NaN;
      if (segments?.length) {
        flows = scene.groundPrimitives.add(
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
                    color: Cesium.ColorGeometryInstanceAttribute.fromColor(colour("#5eead4").withAlpha(0.9)),
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
          position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, ground === null ? 0 : ground + 3),
          point: { pixelSize: p.size ?? 7, color: colour(p.colour), outlineColor: Cesium.Color.BLACK, outlineWidth: 1,
                   heightReference: standing, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        }),
      );
      scene.requestRender();
    },
  };
}
export type SimOverlays = ReturnType<typeof simOverlays>;

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
    terrainProvider: await loadTerrain(meta.layers.terrain.replace(/\/layer\.json$/, "")),
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

  const overlays = simOverlays(viewer, null);

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

  // Section cuts: one clipping plane on the buildings, the line it makes on the ground, and
  // schematic floor plates inside the buildings it passes through.
  const cutPlanes = new Cesium.ClippingPlaneCollection({
    planes: [new Cesium.ClippingPlane(new Cesium.Cartesian3(1, 0, 0), 0)],
    edgeColor: Cesium.Color.fromCssColorString("#f5a524"),
    edgeWidth: 2,
    enabled: false,
  });
  buildings.clippingPlanes = cutPlanes;
  const cutLine = viewer.entities.add({
    show: false,
    polyline: { width: 3, clampToGround: true, material: Cesium.Color.fromCssColorString("#f5a524") },
  });
  let floorPlates: Cesium.Primitive | null = null;
  let floorRun = 0;

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

    /** Slice the buildings: a vertical plane (view side removed) or a horizontal one; null restores them. */
    setSection(cut: ({ kind: "section"; heading: number } | { kind: "plan"; level: number }) & Point | null) {
      cutPlanes.enabled = !!cut;
      buildings.backFaceCulling = !cut; // so the inside of a cut building can be seen
      if (cut) {
        const here = Cesium.Cartographic.fromDegrees(cut.lon, cut.lat);
        const groundZ = scene.globe.getHeight(here) ?? 40;
        const h = cut.kind === "section" ? Cesium.Math.toRadians(cut.heading) : 0;
        const enu = Cesium.Transforms.eastNorthUpToFixedFrame(
          Cesium.Cartesian3.fromDegrees(cut.lon, cut.lat, groundZ + (cut.kind === "plan" ? cut.level : 0)),
        );
        // The plane keeps what its normal points at.
        cutPlanes.get(0).normal = cut.kind === "plan"
          ? new Cesium.Cartesian3(0, 0, -1)
          : new Cesium.Cartesian3(Math.cos(h), -Math.sin(h), 0);
        const origin = (buildings as unknown as { clippingPlanesOriginMatrix: Cesium.Matrix4 }).clippingPlanesOriginMatrix;
        cutPlanes.modelMatrix = Cesium.Matrix4.multiply(Cesium.Matrix4.inverse(origin, new Cesium.Matrix4()), enu, new Cesium.Matrix4());
      }
      scene.requestRender();
    },

    /** Floor plates of the buildings on the cut, and the cut's line on the ground. */
    async setSectionFloors(cut: Json[], ends: number[][] | null) {
      const run = ++floorRun;
      cutLine.show = !!ends;
      if (ends) cutLine.polyline!.positions = new Cesium.ConstantProperty(Cesium.Cartesian3.fromDegreesArray(ends.flat()));
      const places = cut.map((b) => Cesium.Cartographic.fromDegrees(b.lon, b.lat));
      if (places.length) {
        // The flat fallback terrain has no availability data, which "most detailed" requires.
        if (viewer.terrainProvider.availability) await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, places);
        else await Cesium.sampleTerrain(viewer.terrainProvider, 12, places);
      }
      if (run !== floorRun) return;
      const dry = Cesium.ColorGeometryInstanceAttribute.fromColor(Cesium.Color.fromCssColorString("#f3e3c3"));
      const wet = Cesium.ColorGeometryInstanceAttribute.fromColor(Cesium.Color.fromCssColorString("#38bdf8"));
      const ring = (r: number[][]) => Cesium.Cartesian3.fromDegreesArray(r.flat());
      const instances: Cesium.GeometryInstance[] = [];
      cut.forEach((b, n) => {
        const polys = b.outline.type === "Polygon" ? [b.outline.coordinates] : b.outline.coordinates;
        const storey = b.height / b.floors;
        // ponytail: plates stop at floor 60 to keep the cut fast; thin them out if towers need the full stack
        for (let i = 0; i < Math.min(b.floors, 60); i++) {
          const z = places[n].height + i * storey;
          for (const [outer, ...holes] of polys) {
            instances.push(new Cesium.GeometryInstance({
              geometry: new Cesium.PolygonGeometry({
                polygonHierarchy: new Cesium.PolygonHierarchy(ring(outer), holes.map((x: number[][]) => new Cesium.PolygonHierarchy(ring(x)))),
                height: z + 0.05, extrudedHeight: z + 0.4,
                vertexFormat: Cesium.PerInstanceColorAppearance.FLAT_VERTEX_FORMAT,
              }),
              attributes: { color: i < b.wet ? wet : dry },
            }));
          }
        }
      });
      const next = instances.length
        ? scene.primitives.add(new Cesium.Primitive({
            geometryInstances: instances,
            appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: false }),
            asynchronous: false,
          }))
        : null;
      if (floorPlates) scene.primitives.remove(floorPlates);
      floorPlates = next;
      scene.requestRender();
    },

    /** Move the camera to look square-on at the cut. */
    faceSection(at: Point, heading: number) {
      const look = Cesium.Math.toRadians(heading + 90), back = 320;
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(
          at.lon - (back * Math.sin(look)) / (111320 * Math.cos(Cesium.Math.toRadians(at.lat))),
          at.lat - (back * Math.cos(look)) / 110574,
          (scene.globe.getHeight(Cesium.Cartographic.fromDegrees(at.lon, at.lat)) ?? 40) + 90,
        ),
        orientation: { heading: look, pitch: Cesium.Math.toRadians(-14), roll: 0 },
        duration: 1.2,
      });
    },

    /** Colour buildings by GML ID (CSS colours), or return to the plain model with null. */
    colourBuildings(colours: Map<string, string> | null) {
      tint = colours;
      repaint();
    },

    ...overlays,

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
