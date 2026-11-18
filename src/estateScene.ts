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
const LIGHTS: Record<Light, { sun: [number, number, number]; zenith: [number, number, number]; horizon: [number, number, number]; ambient: number; glow: number; shade: number }> = {
  morning: { sun: [1, 0.9, 0.78], zenith: [0.36, 0.55, 0.82], horizon: [0.92, 0.86, 0.78], ambient: 1.0, glow: 0, shade: 0.5 },
  midday: { sun: [1, 0.98, 0.94], zenith: [0.32, 0.54, 0.86], horizon: [0.8, 0.88, 0.95], ambient: 1.05, glow: 0, shade: 0.45 },
  sunset: { sun: [1, 0.78, 0.58], zenith: [0.34, 0.42, 0.62], horizon: [1, 0.64, 0.4], ambient: 0.85, glow: 0.8, shade: 0.66 },
};
const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// PLATEAU has photo textures for only some buildings. The rest get a drawn exterior: each building
// picks its own cladding, window rhythm and roof, and glass reflects the sky. It is illustrative,
// so real photos are left alone and only receive the same soft daylight.
const FACADE = `
float hash1(float n) { return fract(sin(n * 91.345) * 47453.5453); }
float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2(1, 0)), f.x), mix(hash2(i + vec2(0, 1)), hash2(i + vec2(1, 1)), f.x), f.y);
}
float band(float x, float a, float b, float w) { return smoothstep(a - w, a + w, x) * (1.0 - smoothstep(b - w, b + w, x)); }

void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
  vec3 p = fsInput.attributes.positionMC;
  vec3 n = normalize(cross(dFdx(p), dFdy(p)));
  vec3 eye = (czm_inverseModelView * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  if (dot(n, eye - p) < 0.0) n = -n;
  vec3 up = normalize(mat3(czm_inverseModel) * u_up);
  float ny = dot(n, up);
  float wall = 1.0 - smoothstep(0.25, 0.55, abs(ny));
  float height = dot(mat3(czm_model) * p, u_up) + dot(czm_model[3].xyz - u_origin, u_up);
  float contact = mix(1.0, mix(0.58, 1.0, smoothstep(0.0, 10.0, height)), wall); // darker where walls meet the street
  vec3 sky = mix(u_horizon * 1.05, mix(u_horizon, u_zenith, 0.3), max(ny, 0.0));
  float strength = 1.0;
#ifndef HAS_BASE_COLOR_TEXTURE
  strength = 0.72;
  vec3 tint = material.diffuse / max(max(material.diffuse.r, max(material.diffuse.g, material.diffuse.b)), 0.001);
  tint *= tint; // the search highlight arrives as a tint on the plain grey model
  float id = float(fsInput.featureIds.featureId_0);
  float r1 = hash1(id + 1.0), r2 = hash1(id + 7.3), r3 = hash1(id + 13.1), r4 = hash1(id + 21.7), r5 = hash1(id + 33.9);

  vec3 cladding = r1 < 0.32 ? vec3(0.76, 0.73, 0.67) : r1 < 0.56 ? vec3(0.80, 0.71, 0.59) : r1 < 0.76 ? vec3(0.88, 0.86, 0.81)
                : r1 < 0.9 ? vec3(0.66, 0.47, 0.38) : vec3(0.62, 0.62, 0.61);
  vec3 along = normalize(cross(up, n) + vec3(1e-5));
  vec2 m = vec2(dot(p, along), height);
  vec2 size = vec2(mix(2.7, 3.8, r3), mix(2.9, 3.35, r4));
  vec2 cell = m / size;
  vec2 f = fract(cell), bay = floor(cell), w = fwidth(cell) + 1e-4;
  float detail = 1.0 - smoothstep(0.1, 0.42, max(w.x, w.y));
  float rnd = hash2(bay + id);
  float curtain = step(0.9, r2), balcony = step(0.42, r2) * (1.0 - curtain), shop = step(0.5, r5) * (1.0 - step(size.y * 1.15, height));

  float glass, relief = 1.0;
  vec3 c = cladding * (0.9 + 0.14 * noise2(m * vec2(0.5, 0.09) + id)); // weathering runs down the wall
  if (curtain > 0.5) {
    glass = 1.0 - band(f.x, -0.03, 0.03, w.x) - band(f.x, 0.97, 1.03, w.x) - band(f.y, -0.04, 0.04, w.y) - band(f.y, 0.96, 1.04, w.y);
    glass = clamp(glass, 0.0, 1.0);
  } else if (balcony > 0.5) {
    glass = band(f.x, 0.07, 0.93, w.x) * band(f.y, 0.3, 0.86, w.y);
    float rail = band(f.y, 0.07, 0.29, w.y), slab = band(f.y, -0.01, 0.07, w.y);
    c = mix(c, c * 0.72 + 0.05, rail);
    c = mix(c, c * 1.16, slab);
    relief = 1.0 - 0.42 * band(f.y, 0.84, 1.0, w.y); // the slab above shades the balcony
  } else {
    glass = band(f.x, 0.2, 0.8, w.x) * band(f.y, 0.3, 0.8, w.y) * step(r2 < 0.2 ? 0.34 : 0.0, rnd);
    relief = 1.0 - 0.3 * band(f.y, 0.8, 0.86, w.y) * band(f.x, 0.2, 0.8, w.x); // lintel shadow
    c = mix(c, c * 1.1, band(f.y, 0.25, 0.3, w.y) * band(f.x, 0.17, 0.83, w.x)); // sill
  }
  if (shop > 0.5) {
    glass = band(f.x, 0.04, 0.96, w.x) * band(f.y, 0.06, 0.72, w.y);
    c = mix(c * 0.55, vec3(0.2, 0.19, 0.18), band(f.y, 0.72, 0.96, w.y));
  }
  float cover = curtain > 0.5 ? 0.86 : balcony > 0.5 ? 0.42 : 0.24;
  glass = mix(cover, glass, detail) * wall;
  c = mix(cladding * mix(0.86, 1.0, 1.0 - balcony * 0.2), c * relief, detail);

  // Glass: dark panes that mirror the sky, more strongly at grazing angles.
  vec3 nE = normalize(mat3(czm_modelView) * n);
  vec3 v = normalize(fsInput.attributes.positionEC);
  vec3 toSky = czm_inverseViewRotation * reflect(v, nE);
  float rise = clamp(dot(toSky, u_up) * 1.4 + 0.25, 0.0, 1.0);
  vec3 mirror = mix(u_horizon * 0.72, u_zenith, rise);
  float fresnel = 0.38 + 0.62 * pow(1.0 - clamp(dot(-v, nE), 0.0, 1.0), 3.0);
  vec3 pane = mix(vec3(0.05, 0.07, 0.09), vec3(0.13, 0.15, 0.17), rnd);

  vec3 roof;
  if (ny > 0.97) roof = vec3(0.60, 0.59, 0.56) * (0.86 + 0.2 * noise2(p.xy * 0.35 + id)); // flat concrete
  else {
    roof = r1 < 0.55 ? vec3(0.26, 0.28, 0.31) : r1 < 0.8 ? vec3(0.42, 0.33, 0.28) : vec3(0.5, 0.5, 0.48);
    roof *= 0.92 + 0.12 * band(fract(height * 3.2), 0.0, 0.5, fwidth(height * 3.2) + 0.02) * detail;
  }
  material.diffuse = mix(roof, mix(c, pane, glass), wall) * tint;
  material.roughness = mix(0.92, 0.12, glass);
  material.specular = mix(vec3(0.04), vec3(0.3), glass);
  material.emissive += mirror * fresnel * glass * tint * 1.25;
  material.emissive += vec3(1.0, 0.68, 0.36) * glass * step(0.62, rnd) * u_glow * detail * (1.0 - curtain * 0.5);
#endif
  material.emissive += material.diffuse * sky * u_ambient * strength * contact;
  material.diffuse *= contact;
  // Air between the viewer and distant buildings.
  float haze = 1.0 - exp(-length(fsInput.attributes.positionEC) / 11000.0);
  material.diffuse *= 1.0 - haze;
  material.emissive = mix(material.emissive, u_horizon * 0.82, haze);
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
  // Flat LOD2 roofs speckle at the default bias.
  const bias = (scene.shadowMap as unknown as { _primitiveBias?: { depthBias: number; normalOffsetScale: number } })._primitiveBias;
  if (bias) { bias.depthBias = 0.0009; bias.normalOffsetScale = 0.35; }
  viewer.useBrowserRecommendedResolution = false;
  viewer.resolutionScale = Math.min(devicePixelRatio, 1.5);
  scene.shadowMap.darkness = 0.42;
  scene.shadowMap.maximumDistance = 2200;
  scene.postProcessStages.fxaa.enabled = true;

  const OPTIONS: Cesium.Cesium3DTileset.ConstructorOptions = {
    maximumScreenSpaceError: 16, dynamicScreenSpaceError: true,
    shadows: Cesium.ShadowMode.ENABLED,
    preloadFlightDestinations: true, loadSiblings: true, cullRequestsWhileMoving: false,
    progressiveResolutionHeightFraction: 0.5, // something sharp-enough appears first, then refines
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
  const origin = Cesium.Cartesian3.fromDegrees(139.815, 35.715, GROUND);
  const facade = new Cesium.CustomShader({
    mode: Cesium.CustomShaderMode.MODIFY_MATERIAL,
    uniforms: {
      u_up: { type: Cesium.UniformType.VEC3, value: Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(origin) },
      u_origin: { type: Cesium.UniformType.VEC3, value: origin },
      u_zenith: { type: Cesium.UniformType.VEC3, value: new Cesium.Cartesian3(...LIGHTS.midday.zenith) },
      u_horizon: { type: Cesium.UniformType.VEC3, value: new Cesium.Cartesian3(...LIGHTS.midday.horizon) },
      u_glow: { type: Cesium.UniformType.FLOAT, value: 0 },
      u_ambient: { type: Cesium.UniformType.FLOAT, value: LIGHTS.midday.ambient },
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
    Cesium.Cesium3DTileset.fromUrl(url, { ...OPTIONS, maximumScreenSpaceError: 16 }).then((t) => {
      if (url === tiles.trees) t.style = new Cesium.Cesium3DTileStyle({ color: "color('#a9bb9a')" }); // calmer than the source's vivid green
      scene.primitives.add(t);
    }, (e) => console.warn("scenery unavailable:", e));
  river().then((p) => scene.groundPrimitives.add(p), (e) => console.warn("river unavailable:", e));

  // Keep movement smooth: if the device can't hold about 28 frames a second, step quality down.
  if (!location.search.includes("quality=high")) {
    const steps = [
      () => { viewer.resolutionScale = Math.min(viewer.resolutionScale, 1); scene.shadowMap.size = 2048; },
      () => { viewer.resolutionScale = 0.8; scene.msaaSamples = 1; },
      () => { viewer.shadows = false; viewer.terrainShadows = Cesium.ShadowMode.DISABLED; },
    ];
    let frames = 0, since = performance.now(), slow = 0;
    scene.postRender.addEventListener(() => {
      frames++;
      const now = performance.now(), span = now - since;
      if (span < 2500) return;
      const fps = (frames * 1000) / span;
      frames = 0; since = now;
      if (document.hidden || span > 6000) return;
      slow = fps < 28 ? slow + 1 : 0;
      if (slow >= 2 && steps.length) { steps.shift()!(); slow = 0; }
    });
  }

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
        maximumHeight: Math.max(s.range * 1.1, 700), // a gentle arc, not a jump into the sky
        easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
        complete: () => { if (drift && !still()) orbit = target; },
      });
    },

    setLight(light: Light) {
      viewer.clock.currentTime = Cesium.JulianDate.fromIso8601(TIMES[light]);
      const l = LIGHTS[light];
      scene.light = new Cesium.SunLight({ color: new Cesium.Color(...l.sun), intensity: light === "sunset" ? 2.4 : 2 });
      scene.shadowMap.darkness = l.shade;
      facade.setUniform("u_zenith", new Cesium.Cartesian3(...l.zenith));
      facade.setUniform("u_horizon", new Cesium.Cartesian3(...l.horizon));
      facade.setUniform("u_ambient", l.ambient);
      facade.setUniform("u_glow", l.glow);
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
