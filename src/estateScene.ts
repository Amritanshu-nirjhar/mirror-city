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
  z?: number; // metres above ground
}

const GROUND = 38; // ellipsoid height of Sumida's low ground
// A clear mid-October day in Tokyo: the sun sets a little after 17:00.
const TIMES: Record<Light, string> = {
  morning: "2026-10-15T08:10:00+09:00",
  midday: "2026-10-15T12:30:00+09:00",
  sunset: "2026-10-15T16:52:00+09:00",
};
const LIGHTS: Record<Light, { sun: [number, number, number]; zenith: [number, number, number]; horizon: [number, number, number]; ambient: number; glow: number; shade: number; haze: [number, number, number] }> = {
  morning: { sun: [1, 0.9, 0.78], zenith: [0.36, 0.55, 0.82], horizon: [0.92, 0.86, 0.78], ambient: 1.0, glow: 0, shade: 0.5, haze: [0.86, 0.86, 0.84] },
  midday: { sun: [1, 0.98, 0.94], zenith: [0.32, 0.54, 0.86], horizon: [0.8, 0.88, 0.95], ambient: 1.05, glow: 0, shade: 0.45, haze: [0.72, 0.82, 0.91] },
  sunset: { sun: [1, 0.78, 0.58], zenith: [0.34, 0.42, 0.62], horizon: [1, 0.64, 0.4], ambient: 0.85, glow: 0.8, shade: 0.66, haze: [0.95, 0.72, 0.55] },
};
// Render distance, as in games: full detail close to the camera, less further out, nothing new
// beyond the limit, and fog hiding the edge. Fewer tiles to fetch and draw is what keeps it smooth.
export const RENDER_DISTANCES = { near: 1000, medium: 1800, far: 3500 };
export type RenderDistance = keyof typeof RENDER_DISTANCES;
const STREAMING: Cesium.Cesium3DTileset.ConstructorOptions = {
  skipLevelOfDetail: true, baseScreenSpaceError: 1024, skipScreenSpaceErrorFactor: 16, skipLevels: 1,
  preloadFlightDestinations: false, loadSiblings: false, progressiveResolutionHeightFraction: 0,
  cullRequestsWhileMoving: true, dynamicScreenSpaceError: false,
};
// ponytail: wraps a private Cesium method (the version is pinned by package-lock). If an upgrade
// renames it, loading simply stops being limited by distance; the fog still works.
const tileProto = Cesium.Cesium3DTile.prototype as unknown as {
  getScreenSpaceError: (...args: unknown[]) => number; distanceLimited?: boolean;
};
if (tileProto.getScreenSpaceError && !tileProto.distanceLimited) {
  const base = tileProto.getScreenSpaceError;
  tileProto.distanceLimited = true;
  tileProto.getScreenSpaceError = function (this: { _tileset: { renderDistance?: number }; _distanceToCamera: number }, ...args) {
    const error = base.apply(this, args), limit = this._tileset.renderDistance;
    if (!limit) return error;
    const t = Cesium.Math.clamp((this._distanceToCamera - limit * 0.45) / (limit * 0.55), 0, 1);
    return error * (1 - t * t * (3 - 2 * t)); // no error left at the limit, so nothing further is requested
  };
}
const DISTANCE_FOG = `
uniform sampler2D colorTexture;
uniform sampler2D depthTexture;
uniform float u_distance;
uniform vec3 u_haze;
in vec2 v_textureCoordinates;
float metres(vec2 uv) {
  float z = czm_unpackDepth(texture(depthTexture, uv));
  if (z <= 0.0 || z >= 1.0) return -1.0; // sky
  z = czm_reverseLogDepth(z);
  float ndc = (2.0 * z - czm_depthRange.near - czm_depthRange.far) / (czm_depthRange.far - czm_depthRange.near);
  vec4 eye = czm_inverseProjection * vec4(uv * 2.0 - 1.0, ndc, 1.0);
  return length(eye.xyz / eye.w);
}
void main() {
  vec2 uv = v_textureCoordinates;
  vec4 c = texture(colorTexture, uv);
  float d = metres(uv);
  if (d > 0.0) {
    float soft = smoothstep(u_distance * 0.55, u_distance, d);
    if (soft > 0.01) { // a light six-tap blur where detail starts to drop
      vec4 sum = c;
      for (int i = 0; i < 6; i++) {
        float a = float(i) * 1.0472;
        sum += texture(colorTexture, uv + vec2(cos(a), sin(a)) * soft * 2.0 * czm_pixelRatio / czm_viewport.zw);
      }
      c = sum / 7.0;
    }
    c.rgb = mix(c.rgb, u_haze, smoothstep(u_distance * 0.7, u_distance * 1.2, d));
  }
  out_FragColor = c;
}`;
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
  float strength = 1.55; // real photos are dark: lift them to sit with the drawn buildings
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
  // Window columns blur out first, floor lines much later, so walls keep structure at a distance.
  float dx = 1.0 - smoothstep(0.16, 0.5, w.x), dy = 1.0 - smoothstep(0.2, 0.62, w.y), detail = dy;
  float rnd = hash2(bay + id);
  float curtain = step(0.9, r2), balcony = step(0.42, r2) * (1.0 - curtain), shop = step(0.5, r5) * (1.0 - step(size.y * 1.15, height));

  float gx, gy, ax, ay, relief = 1.0; // window coverage across and up each cell, and its average
  vec3 c = cladding * (0.9 + 0.14 * noise2(m * vec2(0.5, 0.09) + id)); // weathering runs down the wall
  if (curtain > 0.5) {
    gx = 1.0 - band(f.x, -0.03, 0.03, w.x) - band(f.x, 0.97, 1.03, w.x); ax = 0.94;
    gy = 1.0 - band(f.y, -0.04, 0.04, w.y) - band(f.y, 0.96, 1.04, w.y); ay = 0.92;
  } else if (balcony > 0.5) {
    gx = band(f.x, 0.07, 0.93, w.x); ax = 0.86;
    gy = band(f.y, 0.3, 0.86, w.y); ay = 0.56;
    float rail = band(f.y, 0.07, 0.29, w.y), slab = band(f.y, -0.01, 0.07, w.y);
    c = mix(c, c * 0.72 + 0.05, rail);
    c = mix(c, c * 1.16, slab);
    relief = 1.0 - 0.42 * band(f.y, 0.84, 1.0, w.y); // the slab above shades the balcony
  } else {
    gx = band(f.x, 0.2, 0.8, w.x) * step(r2 < 0.2 ? 0.34 : 0.0, rnd); ax = r2 < 0.2 ? 0.4 : 0.6;
    gy = band(f.y, 0.3, 0.8, w.y); ay = 0.5;
    relief = 1.0 - 0.3 * band(f.y, 0.8, 0.86, w.y) * mix(0.6, band(f.x, 0.2, 0.8, w.x), dx); // lintel shadow
    c = mix(c, c * 1.1, band(f.y, 0.25, 0.3, w.y) * mix(0.66, band(f.x, 0.17, 0.83, w.x), dx)); // sill
  }
  if (shop > 0.5) {
    gx = band(f.x, 0.04, 0.96, w.x); ax = 0.92;
    gy = band(f.y, 0.06, 0.72, w.y); ay = 0.66;
    c = mix(c * 0.55, vec3(0.2, 0.19, 0.18), band(f.y, 0.72, 0.96, w.y));
  }
  float glass = clamp(mix(ax, gx, dx) * mix(ay, gy, dy), 0.0, 1.0) * wall;
  c = mix(cladding * mix(0.86, 1.0, 1.0 - balcony * 0.2), c * relief, detail);

  // Glass: dark panes that mirror the sky, more strongly at grazing angles.
  vec3 nE = normalize(mat3(czm_modelView) * n);
  vec3 v = normalize(fsInput.attributes.positionEC);
  vec3 toSky = czm_inverseViewRotation * reflect(v, nE);
  float rise = clamp(dot(toSky, u_up) * 1.4 + 0.25, 0.0, 1.0);
  vec3 mirror = mix(u_horizon * 0.72, u_zenith, rise);
  float fresnel = 0.38 + 0.62 * pow(1.0 - clamp(dot(-v, nE), 0.0, 1.0), 3.0);
  vec3 pane = mix(vec3(0.05, 0.07, 0.09), vec3(0.13, 0.15, 0.17), rnd);

  // Roofs come from the aerial survey wherever it covers them.
  vec3 roof = ny > 0.97 ? vec3(0.60, 0.59, 0.56) * (0.86 + 0.2 * noise2(p.xy * 0.35 + id))
            : (r1 < 0.55 ? vec3(0.26, 0.28, 0.31) : r1 < 0.8 ? vec3(0.42, 0.33, 0.28) : vec3(0.5, 0.5, 0.48));
  float aerial = 0.0;
  if (u_photos > 0.5) {
    vec3 world = mat3(czm_model) * p + czm_model[3].xyz - u_origin;
    vec2 en = vec2(dot(world, u_east), dot(world, u_north));
    vec2 a = (en - u_nearMin) / u_nearSize, b = (en - u_wideMin) / u_wideSize;
    bool near = all(greaterThan(a, vec2(0.0))) && all(lessThan(a, vec2(1.0)));
    bool wide = all(greaterThan(b, vec2(0.0))) && all(lessThan(b, vec2(1.0)));
    if (near || wide) {
      vec3 shot = pow((near ? texture(u_near, a) : texture(u_wide, b)).rgb, vec3(2.2));
      // Tall roofs lean away from where the camera plane saw them, so they rely on the photo less.
      roof = mix(shot * 1.25, roof, 0.55 * smoothstep(30.0, 95.0, height));
      aerial = 1.0;
    }
  }
  material.diffuse = mix(roof, mix(c, pane, glass), wall) * tint;
  material.roughness = mix(0.92, 0.12, glass);
  material.specular = mix(vec3(0.04), vec3(0.3), glass);
  material.emissive += mirror * fresnel * glass * tint * 1.25;
  material.emissive += roof * (1.0 - wall) * aerial * 0.12 * tint;
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

/** Google's photorealistic city through Cesium ion, when a token is configured; otherwise null. */
async function loadPhotoreal() {
  const token = import.meta.env.VITE_CESIUM_ION_TOKEN as string | undefined;
  if (!token) return null;
  Cesium.Ion.defaultAccessToken = token;
  try {
    return await Cesium.createGooglePhotorealistic3DTileset(undefined, {
      ...STREAMING, showCreditsOnScreen: true, maximumScreenSpaceError: 16,
      cacheBytes: 384 * 1024 * 1024, maximumCacheOverflowBytes: 256 * 1024 * 1024,
    });
  } catch (e) {
    console.warn("Photorealistic tiles unavailable, using the PLATEAU city:", e);
    return null;
  }
}

export async function createEstate(container: HTMLElement, tiles: Json, onPick: (id: string | null, at: Point | null) => void) {
  const google = await loadPhotoreal();
  const viewer = new Cesium.Viewer(container, {
    ...(google ? { globe: false as const, baseLayer: false as const, skyBox: false as const, skyAtmosphere: new Cesium.SkyAtmosphere() } : {
      baseLayer: new Cesium.ImageryLayer(new Cesium.UrlTemplateImageryProvider({
        url: "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg",
        minimumLevel: 2, maximumLevel: 18,
        credit: new Cesium.Credit("GSI seamless aerial photo"),
      })),
      terrainProvider: await loadTerrain(tiles.terrain.replace(/\/layer\.json$/, "")),
      shadows: true,
      terrainShadows: Cesium.ShadowMode.RECEIVE_ONLY,
    }),
    msaaSamples: 4,
    animation: false, timeline: false, baseLayerPicker: false, geocoder: false, homeButton: false,
    sceneModePicker: false, navigationHelpButton: false, fullscreenButton: false, infoBox: false, selectionIndicator: false,
  });
  const { scene, camera } = viewer;
  viewer.clock.shouldAnimate = false;
  viewer.useBrowserRecommendedResolution = false;
  viewer.resolutionScale = Math.min(devicePixelRatio, 1.5);
  const credits = viewer.cesiumWidget.creditContainer as HTMLElement;
  if (google) {
    // Google's attribution must stay visible; the search panel covers the default corner.
    Object.assign(credits.style, { position: "absolute", top: "52px", left: "16px", bottom: "auto", zIndex: "5" });
    scene.primitives.add(google);
    scene.backgroundColor = Cesium.Color.fromCssColorString("#a9cbe8"); // daylight behind the thin edge of the atmosphere
    // Google's mesh is built for aerial views: stop the camera going into it.
    scene.screenSpaceCameraController.minimumZoomDistance = 120;
  } else {
    credits.style.display = "none"; // credited under Sources
    viewer.imageryLayers.get(0).brightness = 1.12;
    viewer.imageryLayers.get(0).saturation = 1.2;
    scene.globe.enableLighting = true;
    scene.globe.depthTestAgainstTerrain = true;
    scene.globe.maximumScreenSpaceError = 1.6;
    scene.shadowMap.softShadows = true;
    scene.shadowMap.size = 4096;
    // Flat LOD2 roofs speckle at the default bias.
    const bias = (scene.shadowMap as unknown as { _primitiveBias?: { depthBias: number; normalOffsetScale: number } })._primitiveBias;
    if (bias) { bias.depthBias = 0.0009; bias.normalOffsetScale = 0.35; }
    scene.shadowMap.darkness = 0.42;
    scene.shadowMap.maximumDistance = 2200;
  }
  scene.postProcessStages.fxaa.enabled = true;
  let chosenDistance = RENDER_DISTANCES.medium, quality = 1, shotRange = 0, limit = chosenDistance;
  let haze = new Cesium.Cartesian3(0.72, 0.82, 0.91);
  scene.postProcessStages.add(new Cesium.PostProcessStage({
    fragmentShader: DISTANCE_FOG,
    uniforms: { u_distance: () => limit, u_haze: () => haze },
  }));

  const OPTIONS: Cesium.Cesium3DTileset.ConstructorOptions = {
    maximumScreenSpaceError: 16,
    shadows: Cesium.ShadowMode.ENABLED,
    ...STREAMING,
    cacheBytes: 512 * 1024 * 1024, maximumCacheOverflowBytes: 256 * 1024 * 1024,
  };
  let textured = true;
  let buildings: Cesium.Cesium3DTileset;
  try {
    buildings = await Cesium.Cesium3DTileset.fromUrl(tiles.buildings, OPTIONS);
  } catch {
    textured = false;
    buildings = await Cesium.Cesium3DTileset.fromUrl(tiles.plain, OPTIONS);
  }
  buildings.colorBlendMode = google ? Cesium.Cesium3DTileColorBlendMode.REPLACE : Cesium.Cesium3DTileColorBlendMode.MIX;
  buildings.colorBlendAmount = 0.42;
  if (google) buildings.shadows = Cesium.ShadowMode.DISABLED;
  const origin = Cesium.Cartesian3.fromDegrees(139.815, 35.715, GROUND);
  const frame = Cesium.Transforms.eastNorthUpToFixedFrame(origin);
  const axis = (i: number) => Cesium.Cartesian3.fromCartesian4(Cesium.Matrix4.getColumn(frame, i, new Cesium.Cartesian4()));
  const photos: Json = await fetch("/roofs.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const photoTexture = (p?: Json) => ({
    type: Cesium.UniformType.SAMPLER_2D,
    value: new Cesium.TextureUniform({
      url: p?.url ?? "data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=",
      repeat: false, minificationFilter: Cesium.TextureMinificationFilter.LINEAR_MIPMAP_LINEAR,
      magnificationFilter: Cesium.TextureMagnificationFilter.LINEAR, maximumAnisotropy: 8,
    }),
  });
  const photoBounds = (name: string, p?: Json) => {
    const local = (lon: number, lat: number) => {
      const d = Cesium.Cartesian3.subtract(Cesium.Cartesian3.fromDegrees(lon, lat, GROUND), origin, new Cesium.Cartesian3());
      return new Cesium.Cartesian2(Cesium.Cartesian3.dot(d, axis(0)), Cesium.Cartesian3.dot(d, axis(1)));
    };
    const min = p ? local(p.west, p.south) : new Cesium.Cartesian2(), max = p ? local(p.east, p.north) : new Cesium.Cartesian2(1, 1);
    return {
      [`u_${name}Min`]: { type: Cesium.UniformType.VEC2, value: min },
      [`u_${name}Size`]: { type: Cesium.UniformType.VEC2, value: Cesium.Cartesian2.subtract(max, min, new Cesium.Cartesian2()) },
    };
  };
  const facade = new Cesium.CustomShader({
    mode: Cesium.CustomShaderMode.MODIFY_MATERIAL,
    uniforms: {
      u_up: { type: Cesium.UniformType.VEC3, value: Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(origin) },
      u_origin: { type: Cesium.UniformType.VEC3, value: origin },
      u_zenith: { type: Cesium.UniformType.VEC3, value: new Cesium.Cartesian3(...LIGHTS.midday.zenith) },
      u_horizon: { type: Cesium.UniformType.VEC3, value: new Cesium.Cartesian3(...LIGHTS.midday.horizon) },
      u_glow: { type: Cesium.UniformType.FLOAT, value: 0 },
      u_east: { type: Cesium.UniformType.VEC3, value: axis(0) },
      u_north: { type: Cesium.UniformType.VEC3, value: axis(1) },
      u_photos: { type: Cesium.UniformType.FLOAT, value: photos ? 1 : 0 },
      u_near: photoTexture(photos?.near),
      u_wide: photoTexture(photos?.wide),
      ...photoBounds("near", photos?.near),
      ...photoBounds("wide", photos?.wide),
      u_ambient: { type: Cesium.UniformType.FLOAT, value: LIGHTS.midday.ambient },
    },
    fragmentShaderText: FACADE,
  });
  if (!google) buildings.customShader = facade;
  // The real wards around Sumida, plain and light: the skyline in wide views.
  if (!google) for (const url of tiles.context ?? [])
    Cesium.Cesium3DTileset.fromUrl(url, { maximumScreenSpaceError: 40, dynamicScreenSpaceError: true, cacheBytes: 128 * 1024 * 1024, shadows: Cesium.ShadowMode.DISABLED, skipLevelOfDetail: true })
      .then((t) => { t.customShader = facade; scene.primitives.add(t); }, (e) => console.warn("skyline unavailable:", e));
  scene.primitives.add(buildings);
  // Trees, bridges and the river are scenery: the page still works without them.
  if (!google) for (const url of [tiles.trees, tiles.bridges])
    Cesium.Cesium3DTileset.fromUrl(url, { ...OPTIONS, maximumScreenSpaceError: 16 }).then((t) => {
      if (url === tiles.trees) t.style = new Cesium.Cesium3DTileStyle({ color: "color('#a9bb9a')" }); // calmer than the source's vivid green
      scene.primitives.add(t);
    }, (e) => console.warn("scenery unavailable:", e));
  if (!google) river().then((p) => scene.groundPrimitives.add(p), (e) => console.warn("river unavailable:", e));

  // Keep movement smooth: if the device can't hold about 28 frames a second, step quality down.
  if (!location.search.includes("quality=high")) {
    const steps = [
      () => { quality = 0.75; },
      () => { viewer.resolutionScale = Math.min(viewer.resolutionScale, 1); scene.shadowMap.size = 2048; },
      () => { viewer.resolutionScale = 0.8; scene.msaaSamples = 1; quality = 0.55; },
      () => { if (!google) { viewer.shadows = false; viewer.terrainShadows = Cesium.ShadowMode.DISABLED; } },
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

  // The limit eases towards its target, widening for high or far-away viewpoints so they never sit in fog.
  scene.preRender.addEventListener(() => {
    const height = Math.max(camera.positionCartographic.height - GROUND, 0);
    limit += (Math.max(chosenDistance * quality, shotRange, height * 2.4) - limit) * 0.05;
    for (const t of [google, buildings]) if (t) (t as unknown as { renderDistance: number }).renderDistance = limit;
  });

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
      if (google) { // the photographic city shows through; only search results are drawn over it
        f.show = id === selected || matches.has(id);
        f.color = (id === selected ? PICKED : GOLD).withAlpha(id === selected ? 0.62 : 0.42);
      } else f.color = id === selected ? PICKED : matches.has(id) ? GOLD : WHITE;
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
    const spot = google && scene.pickPositionSupported ? scene.pickPosition(e.position) : undefined;
    const c = spot && Cesium.Cartographic.fromCartesian(spot);
    onPick(hit instanceof Cesium.Cesium3DTileFeature ? hit.getProperty("gml_id") ?? null : null,
           c ? { lon: Cesium.Math.toDegrees(c.longitude), lat: Cesium.Math.toDegrees(c.latitude) } : null);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  return {
    textured,
    photoreal: !!google,
    destroy: () => viewer.destroy(),

    /** Glide to a viewpoint. With `drift`, keep circling it slowly until the visitor takes over. */
    go(s: Shot, seconds = 3.2, drift = false) {
      stopOrbit();
      shotRange = s.range * 1.35;
      const target = Cesium.Cartesian3.fromDegrees(s.lon, s.lat, GROUND + s.z);
      camera.flyToBoundingSphere(new Cesium.BoundingSphere(target, 1), {
        offset: new Cesium.HeadingPitchRange(Cesium.Math.toRadians(s.heading), Cesium.Math.toRadians(s.pitch), s.range),
        duration: still() ? 0 : seconds,
        maximumHeight: Math.max(s.range * 1.1, 700), // a gentle arc, not a jump into the sky
        easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
        complete: () => { if (drift && !still()) orbit = target; },
      });
    },

    setRenderDistance(d: RenderDistance) {
      chosenDistance = RENDER_DISTANCES[d];
    },

    setLight(light: Light) {
      viewer.clock.currentTime = Cesium.JulianDate.fromIso8601(TIMES[light]);
      const l = LIGHTS[light];
      haze = new Cesium.Cartesian3(...l.haze);
      if (google) return; // its daylight is part of the photographs
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
        position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, google ? GROUND + (p.z ?? 24) : 0),
        point: { pixelSize: 8, color: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK.withAlpha(0.5), outlineWidth: 1,
                 heightReference: google ? Cesium.HeightReference.NONE : Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: { text: p.label, font: "500 12px Inter Tight, Noto Sans JP, sans-serif", fillColor: Cesium.Color.WHITE,
                 showBackground: true, backgroundColor: Cesium.Color.fromCssColorString("#15130f").withAlpha(0.72),
                 backgroundPadding: new Cesium.Cartesian2(7, 4), pixelOffset: new Cesium.Cartesian2(0, -18),
                 heightReference: google ? Cesium.HeightReference.NONE : Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      }));
    },
  };
}

export type Estate = Awaited<ReturnType<typeof createEstate>>;
