// The Residences scene: PLATEAU's photo-textured city on GSI aerial imagery, with real sun,
// shadows, sky and river, and slow camera moves between places.
import * as Cesium from "cesium";
import { api, type Json, type Point } from "./api";
import { loadTerrain } from "./viewer";

export interface Shot extends Point {
  z: number; // metres above ground of the point the camera looks at
  heading: number;
  pitch: number;
  range: number;
}
export type Light = "morning" | "midday" | "sunset";
export interface Pin extends Point {
  label: string;
}

const GROUND = 38; // ellipsoid height of Sumida's low ground
// A clear mid-October day in Tokyo: the sun sets a little after 17:00.
const TIMES: Record<Light, string> = {
  morning: "2026-10-15T08:10:00+09:00",
  midday: "2026-10-15T12:30:00+09:00",
  sunset: "2026-10-15T16:52:00+09:00",
};
const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// PLATEAU has photo textures for only some buildings. The rest get a drawn facade: windows and
// floor ledges on the walls, pale roofs. It is illustrative, so real photos are always left alone.
const FACADE = `
void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
  float lit = 1.0;
#ifndef HAS_BASE_COLOR_TEXTURE
  lit = 0.58;
  // The search highlight arrives as a tint on the plain grey model: carry it onto the facade.
  vec3 tint = material.diffuse / max(max(material.diffuse.r, max(material.diffuse.g, material.diffuse.b)), 0.001);
  tint *= tint;
  vec3 p = fsInput.attributes.positionMC;
  vec3 n = normalize(cross(dFdx(p), dFdy(p)));
  vec3 up = normalize(mat3(czm_inverseModel) * u_up);
  float wall = 1.0 - smoothstep(0.25, 0.55, abs(dot(n, up)));
  vec3 along = normalize(cross(up, n) + vec3(1e-5));
  vec2 cell = vec2(dot(p, along) / 3.0, dot(p, up) / 3.1);
  vec2 f = fract(cell), id = floor(cell), w = fwidth(cell) + 1e-4;
  float glass = smoothstep(0.14 - w.x, 0.14 + w.x, f.x) * (1.0 - smoothstep(0.86 - w.x, 0.86 + w.x, f.x))
              * smoothstep(0.26 - w.y, 0.26 + w.y, f.y) * (1.0 - smoothstep(0.84 - w.y, 0.84 + w.y, f.y));
  float far = smoothstep(0.2, 0.65, max(w.x, w.y));
  glass = mix(glass, 0.3, far) * wall; // far away, windows average out
  float r = fract(sin(dot(id, vec2(12.9898, 78.233))) * 43758.5453);
  float ledge = (1.0 - smoothstep(0.08, 0.13 + w.y, f.y)) * wall;
  vec3 c = mix(vec3(0.78, 0.76, 0.71), vec3(0.86, 0.82, 0.75) * (1.0 - 0.22 * ledge), wall);
  material.diffuse = mix(c, mix(vec3(0.24, 0.32, 0.38), vec3(0.42, 0.54, 0.62), r), glass) * tint;
  material.roughness = mix(0.9, 0.18, glass);
  material.emissive += vec3(1.0, 0.68, 0.36) * glass * step(0.68, r) * u_glow * (1.0 - far);
#endif
  material.emissive += material.diffuse * u_ambient * lit; // daylight from the whole sky, which the sun alone misses
}`;

function river() {
  return api("/water/geojson").then((fc: Json) => {
    const ring = (r: number[][]) => Cesium.Cartesian3.fromDegreesArray(r.flat());
    const instances = fc.features.flatMap((f: Json) =>
      (f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates).map(([outer, ...holes]: number[][][]) =>
        new Cesium.GeometryInstance({
          geometry: new Cesium.PolygonGeometry({
            polygonHierarchy: new Cesium.PolygonHierarchy(ring(outer), holes.map((h) => new Cesium.PolygonHierarchy(ring(h)))),
            vertexFormat: Cesium.EllipsoidSurfaceAppearance.VERTEX_FORMAT,
          }),
        })),
    );
    return new Cesium.GroundPrimitive({
      geometryInstances: instances,
      classificationType: Cesium.ClassificationType.TERRAIN,
      appearance: new Cesium.EllipsoidSurfaceAppearance({
        aboveGround: false,
        material: Cesium.Material.fromType("Water", {
          baseWaterColor: new Cesium.Color(0.1, 0.24, 0.3, 0.86),
          normalMap: Cesium.buildModuleUrl("Assets/Textures/waterNormals.jpg"),
          frequency: 900, animationSpeed: 0.006, amplitude: 2.5, specularIntensity: 0.35,
        }),
      }),
    });
  });
}

export async function createEstate(container: HTMLElement, tiles: Json, onPick: (id: string | null) => void) {
  const viewer = new Cesium.Viewer(container, {
    baseLayer: new Cesium.ImageryLayer(new Cesium.UrlTemplateImageryProvider({
      url: "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg",
      minimumLevel: 2, maximumLevel: 18,
      credit: new Cesium.Credit("GSI seamless aerial photo"),
    })),
    terrainProvider: await loadTerrain(tiles.terrain.replace(/\/layer\.json$/, "")),
    shadows: true,
    terrainShadows: Cesium.ShadowMode.RECEIVE_ONLY,
    msaaSamples: 4,
    animation: false, timeline: false, baseLayerPicker: false, geocoder: false, homeButton: false,
    sceneModePicker: false, navigationHelpButton: false, fullscreenButton: false, infoBox: false, selectionIndicator: false,
  });
  const { scene, camera } = viewer;
  (viewer.cesiumWidget.creditContainer as HTMLElement).style.display = "none"; // credited under Sources
  viewer.imageryLayers.get(0).brightness = 1.12;
  viewer.imageryLayers.get(0).saturation = 1.2;
  viewer.clock.shouldAnimate = false;
  scene.globe.enableLighting = true;
  scene.globe.depthTestAgainstTerrain = true;
  scene.globe.maximumScreenSpaceError = 1.6;
  scene.shadowMap.softShadows = true;
  scene.shadowMap.size = 4096;
  scene.shadowMap.darkness = 0.42;
  scene.shadowMap.maximumDistance = 2200;
  scene.postProcessStages.fxaa.enabled = true;

  const OPTIONS: Cesium.Cesium3DTileset.ConstructorOptions = {
    maximumScreenSpaceError: 16, dynamicScreenSpaceError: true,
    shadows: Cesium.ShadowMode.CAST_ONLY, // receiving too speckles the simple roofs
    cacheBytes: 512 * 1024 * 1024, maximumCacheOverflowBytes: 256 * 1024 * 1024,
    foveatedScreenSpaceError: true, skipLevelOfDetail: true,
  };
  let textured = true;
  let buildings: Cesium.Cesium3DTileset;
  try {
    buildings = await Cesium.Cesium3DTileset.fromUrl(tiles.buildings, OPTIONS);
  } catch {
    textured = false;
    buildings = await Cesium.Cesium3DTileset.fromUrl(tiles.plain, OPTIONS);
  }
  buildings.colorBlendMode = Cesium.Cesium3DTileColorBlendMode.MIX;
  buildings.colorBlendAmount = 0.42;
  const facade = new Cesium.CustomShader({
    mode: Cesium.CustomShaderMode.MODIFY_MATERIAL,
    uniforms: {
      u_up: { type: Cesium.UniformType.VEC3, value: Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(Cesium.Cartesian3.fromDegrees(139.815, 35.715)) },
      u_glow: { type: Cesium.UniformType.FLOAT, value: 0 },
      u_ambient: { type: Cesium.UniformType.FLOAT, value: 0.62 },
    },
    fragmentShaderText: FACADE,
  });
  buildings.customShader = facade;
  // The real wards around Sumida, plain and light: the skyline in wide views.
  for (const url of tiles.context ?? [])
    Cesium.Cesium3DTileset.fromUrl(url, { maximumScreenSpaceError: 40, dynamicScreenSpaceError: true, cacheBytes: 128 * 1024 * 1024, shadows: Cesium.ShadowMode.DISABLED, skipLevelOfDetail: true })
      .then((t) => { t.customShader = facade; scene.primitives.add(t); }, (e) => console.warn("skyline unavailable:", e));
  scene.primitives.add(buildings);
  // Trees, bridges and the river are scenery: the page still works without them.
  for (const url of [tiles.trees, tiles.bridges])
    Cesium.Cesium3DTileset.fromUrl(url, { ...OPTIONS, maximumScreenSpaceError: 16 }).then((t) => scene.primitives.add(t), (e) => console.warn("scenery unavailable:", e));
  river().then((p) => scene.groundPrimitives.add(p), (e) => console.warn("river unavailable:", e));

  let matches = new Set<string>();
  let selected: string | null = null;
  let paint = 0;
  const painted = new WeakMap<object, number>();
  const WHITE = Cesium.Color.WHITE, GOLD = Cesium.Color.fromCssColorString("#ffb24d"), PICKED = Cesium.Color.fromCssColorString("#ff6a13");
  buildings.tileVisible.addEventListener((tile: Cesium.Cesium3DTile) => {
    const c = tile.content;
    if (painted.get(c) === paint) return;
    painted.set(c, paint);
    for (let i = 0; i < c.featuresLength; i++) {
      const f = c.getFeature(i), id = f.getProperty("gml_id");
      f.color = id === selected ? PICKED : matches.has(id) ? GOLD : WHITE;
    }
  });

  let pins: Cesium.Entity[] = [];
  let orbit: Cesium.Cartesian3 | null = null;
  const stopOrbit = () => { orbit = null; };
  scene.preUpdate.addEventListener(() => {
    if (!orbit) return;
    camera.lookAtTransform(Cesium.Transforms.eastNorthUpToFixedFrame(orbit));
    camera.rotateRight(0.00035);
    camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  });
  const canvas = scene.canvas;
  for (const type of ["pointerdown", "wheel", "touchstart"]) canvas.addEventListener(type, stopOrbit, { passive: true });

  new Cesium.ScreenSpaceEventHandler(canvas).setInputAction((e: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
    const hit = scene.pick(e.position);
    onPick(hit instanceof Cesium.Cesium3DTileFeature ? hit.getProperty("gml_id") ?? null : null);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  return {
    textured,
    destroy: () => viewer.destroy(),

    /** Glide to a viewpoint. With `drift`, keep circling it slowly until the visitor takes over. */
    go(s: Shot, seconds = 3.2, drift = false) {
      stopOrbit();
      const target = Cesium.Cartesian3.fromDegrees(s.lon, s.lat, GROUND + s.z);
      camera.flyToBoundingSphere(new Cesium.BoundingSphere(target, 1), {
        offset: new Cesium.HeadingPitchRange(Cesium.Math.toRadians(s.heading), Cesium.Math.toRadians(s.pitch), s.range),
        duration: still() ? 0 : seconds,
        easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
        complete: () => { if (drift && !still()) orbit = target; },
      });
    },

    setLight(light: Light) {
      viewer.clock.currentTime = Cesium.JulianDate.fromIso8601(TIMES[light]);
      scene.shadowMap.darkness = light === "sunset" ? 0.62 : 0.42;
      facade.setUniform("u_glow", light === "sunset" ? 0.75 : 0);
      facade.setUniform("u_ambient", light === "sunset" ? 0.42 : 0.62);
    },

    /** Gold for buildings matching the search; the chosen one brightest. */
    setMatches(ids: Set<string>, chosen: string | null) {
      matches = ids;
      selected = chosen;
      paint++;
    },

    setPins(list: Pin[]) {
      pins.forEach((p) => viewer.entities.remove(p));
      pins = list.map((p) => viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat),
        point: { pixelSize: 8, color: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK.withAlpha(0.5), outlineWidth: 1,
                 heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: { text: p.label, font: "500 12px Inter Tight, Noto Sans JP, sans-serif", fillColor: Cesium.Color.WHITE,
                 showBackground: true, backgroundColor: Cesium.Color.fromCssColorString("#15130f").withAlpha(0.72),
                 backgroundPadding: new Cesium.Cartesian2(7, 4), pixelOffset: new Cesium.Cartesian2(0, -18),
                 heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      }));
    },
  };
}

export type Estate = Awaited<ReturnType<typeof createEstate>>;
