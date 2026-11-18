// The Residences scene: PLATEAU's photo-textured city on GSI aerial imagery, with real sun,
// shadows, sky and river, and slow camera moves between places.
import * as Cesium from "cesium";
import { api, type Json, type Point } from "./api";
import { loadTerrain } from "./viewer";
import { ParticleWater, peakDepth, NEVER, type FloodField } from "./floodSim";

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
const LIGHTS: Record<Light, { sun: [number, number, number]; zenith: [number, number, number]; horizon: [number, number, number]; ambient: number; glow: number; shade: number }> = {
  morning: { sun: [1, 0.9, 0.78], zenith: [0.36, 0.55, 0.82], horizon: [0.92, 0.86, 0.78], ambient: 1.0, glow: 0, shade: 0.5 },
  midday: { sun: [1, 0.98, 0.94], zenith: [0.32, 0.54, 0.86], horizon: [0.8, 0.88, 0.95], ambient: 1.05, glow: 0, shade: 0.45 },
  sunset: { sun: [1, 0.78, 0.58], zenith: [0.34, 0.42, 0.62], horizon: [1, 0.64, 0.4], ambient: 0.85, glow: 0.8, shade: 0.66 },
};
// Render radius: a circle on the ground around the point the camera is looking at. Inside it the
// city loads in full detail. Outside it stays visible at reduced detail, softly blurred.
export const RADIUS = { min: 300, max: 3000, initial: 1200 };
export interface RenderStatus extends Point {
  loading: number; // tiles still being fetched or prepared
  memoryMB: number;
  height: number; // camera height above ground, metres
  lod: number[]; // tiles drawn in each LOD ring
  levels: [number, number] | null; // shallowest and deepest level of the HLOD tree being drawn
}
// LOD rings: distance beyond the radius (as a share of it) and the detail demanded there.
const LOD_RINGS: [number, number][] = [[0, 1], [0.25, 0.5], [0.75, 0.25], [1.5, 0.12]];
function ringDetail(gap: number) {
  if (gap <= 0) return 1;
  for (let i = 1; i < LOD_RINGS.length; i++) {
    const [a, da] = LOD_RINGS[i - 1], [b, db] = LOD_RINGS[i];
    if (gap < b) return Cesium.Math.lerp(da, db, (gap - a) / (b - a));
  }
  return LOD_RINGS[LOD_RINGS.length - 1][1];
}
const ringOf = (gap: number) => (gap <= 0 ? 0 : gap < 0.25 ? 1 : gap < 0.75 ? 2 : 3);
const treeLevels = new WeakMap<object, number>();
function treeLevel(tile: Cesium.Cesium3DTile): number {
  let n = treeLevels.get(tile);
  if (n === undefined) treeLevels.set(tile, (n = tile.parent ? treeLevel(tile.parent) + 1 : 0));
  return n;
}
const STREAMING: Cesium.Cesium3DTileset.ConstructorOptions = {
  // Hierarchical LOD: walk the tile tree level by level, and keep a parent on screen until its
  // children are ready, so detail refines in place and no holes or stray shards appear.
  skipLevelOfDetail: false,
  preloadFlightDestinations: false, loadSiblings: false, progressiveResolutionHeightFraction: 0,
  cullRequestsWhileMoving: true, dynamicScreenSpaceError: false,
  foveatedScreenSpaceError: false, // it would hold tiles back for as long as the camera drifts
};
type RadiusTileset = { renderRadius?: number; renderFocus?: Cesium.Cartesian3 };
// ponytail: wraps a private Cesium method (the version is pinned by package-lock). If an upgrade
// renames it, detail stops following the radius; the blur and ring still work.
const tileProto = Cesium.Cesium3DTile.prototype as unknown as {
  getScreenSpaceError: (...args: unknown[]) => number; radiusLimited?: boolean;
};
if (tileProto.getScreenSpaceError && !tileProto.radiusLimited) {
  const base = tileProto.getScreenSpaceError;
  tileProto.radiusLimited = true;
  tileProto.getScreenSpaceError = function (this: { _tileset: RadiusTileset; boundingSphere: Cesium.BoundingSphere }, ...args) {
    const error = base.apply(this, args), { renderRadius: r, renderFocus: f } = this._tileset;
    if (!r || !f) return error;
    const gap = Cesium.Cartesian3.distance(this.boundingSphere.center, f) - this.boundingSphere.radius - r;
    return error * ringDetail(gap / r);
  };
}
const RADIUS_LENS = `
uniform sampler2D colorTexture;
uniform sampler2D depthTexture;
uniform float u_radius;
uniform vec3 u_focus;
uniform vec3 u_up;
in vec2 v_textureCoordinates;
// Ground distance from the focus point in metres; -1 for sky.
float fromFocus(vec2 uv) {
  float z = czm_unpackDepth(texture(depthTexture, uv));
  if (z <= 0.0 || z >= 1.0) return -1.0;
  z = czm_reverseLogDepth(z);
  float ndc = (2.0 * z - czm_depthRange.near - czm_depthRange.far) / (czm_depthRange.far - czm_depthRange.near);
  vec4 eye = czm_inverseProjection * vec4(uv * 2.0 - 1.0, ndc, 1.0);
  vec3 v = eye.xyz / eye.w - u_focus;
  return length(v - u_up * dot(v, u_up));
}
void main() {
  vec2 uv = v_textureCoordinates;
  float d = fromFocus(uv);
  float amount = d < 0.0 ? 1.0 : smoothstep(u_radius * 0.96, u_radius * 1.3, d);
  vec4 c = texture(colorTexture, uv);
  if (amount > 0.004) {
    vec4 sum = c;
    for (int i = 1; i <= 16; i++) {
      float a = float(i) * 2.39996, r = sqrt(float(i) / 16.0);
      sum += texture(colorTexture, uv + vec2(cos(a), sin(a)) * r * amount * 7.0 * czm_pixelRatio / czm_viewport.zw);
    }
    c = sum / 17.0;
  }
  if (d >= 0.0) {
    float grey = dot(c.rgb, vec3(0.3, 0.59, 0.11));
    c.rgb = mix(c.rgb, vec3(grey), amount * 0.18) * (1.0 - amount * 0.16);
    float width = clamp(fwidth(d) * 2.2, 1.0, u_radius * 0.02);
    c.rgb = mix(c.rgb, vec3(1.0), 0.85 * (1.0 - smoothstep(0.0, width, abs(d - u_radius))));
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

/**
 * Google's photorealistic city. A Google Maps key loads it directly; otherwise a Cesium ion token
 * loads it through ion, whose terms require the ion logo to stay on screen.
 */
async function loadPhotoreal() {
  const key = import.meta.env.VITE_GOOGLE_MAPS_KEY as string | undefined;
  const token = import.meta.env.VITE_CESIUM_ION_TOKEN as string | undefined;
  if (!key && !token) return null;
  if (token) Cesium.Ion.defaultAccessToken = token;
  try {
    const tileset = await Cesium.createGooglePhotorealistic3DTileset({ key: key || undefined, onlyUsingWithGoogleGeocoder: true }, {
      ...STREAMING, showCreditsOnScreen: true, maximumScreenSpaceError: 16,
      cacheBytes: 256 * 1024 * 1024, maximumCacheOverflowBytes: 128 * 1024 * 1024,
    });
    return { tileset, direct: !!key };
  } catch (e) {
    console.warn("Photorealistic tiles unavailable, using the PLATEAU city:", e);
    return null;
  }
}

const DATUM = 36.9; // height of Tokyo Bay mean sea level above the ellipsoid here (geoid), metres
const WATER_VS = `
in vec3 position3DHigh;
in vec3 position3DLow;
in float batchId;
in float arrive;
in float peak;
uniform float u_t;
uniform vec3 u_up;
out float v_age;
out float v_peak;
out vec3 v_eye;
out vec3 v_world;
void main() {
  float rise = clamp((u_t - arrive + 0.25) / 3.0, 0.0, 1.0);
  vec4 p = czm_translateRelativeToEye(position3DHigh, position3DLow);
  p.xyz += u_up * (peak * rise + 0.08);
  v_age = u_t - arrive;
  v_peak = peak;
  v_world = position3DLow + position3DHigh;
  vec4 eye = czm_modelViewRelativeToEye * p;
  v_eye = eye.xyz;
  gl_Position = czm_projection * eye;
}`;
const WATER_FS = `
in float v_age;
in float v_peak;
in vec3 v_eye;
in vec3 v_world;
uniform vec3 u_up;
uniform vec3 u_east;
float wave(vec2 p, float t) {
  return sin(p.x * 0.19 + t * 1.3) * 0.5 + sin(p.y * 0.23 - t * 1.1) * 0.5 + sin((p.x + p.y) * 0.47 + t * 2.1) * 0.25 + sin((p.x - p.y) * 0.83 - t * 2.7) * 0.12;
}
void main() {
  if (v_age < 0.0 || v_peak <= 0.0) discard;
  vec3 north = cross(u_up, u_east);
  vec2 p = vec2(dot(v_world, u_east), dot(v_world, north));
  float t = czm_frameNumber / 60.0, e = 0.8;
  float h = wave(p, t);
  vec3 nW = normalize(u_up + (u_east * (h - wave(p + vec2(e, 0.0), t)) + north * (h - wave(p + vec2(0.0, e), t))) * 0.22);
  vec3 n = normalize(czm_viewRotation * nW), v = normalize(-v_eye);
  float fresnel = 0.18 + 0.82 * pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 3.0);
  vec3 sky = mix(vec3(0.62, 0.74, 0.84), vec3(0.3, 0.48, 0.7), clamp(reflect(-v, n).y, 0.0, 1.0));
  vec3 deep = mix(vec3(0.34, 0.30, 0.22), vec3(0.09, 0.16, 0.18), smoothstep(0.3, 4.0, v_peak)); // silty river water
  vec3 c = mix(deep, sky, fresnel);
  float sun = pow(clamp(dot(reflect(-v, n), normalize(czm_sunDirectionEC)), 0.0, 1.0), 180.0);
  float foam = (1.0 - smoothstep(0.0, 1.1, v_age)) * smoothstep(0.1, 0.9, h * 0.5 + 0.5 + sin(p.x * 1.7 + t * 3.0) * 0.2);
  out_FragColor = vec4(mix(c + sun * vec3(1.0, 0.95, 0.85), vec3(0.93, 0.95, 0.94), foam), mix(0.86, 0.95, foam));
}`;

export async function createEstate(container: HTMLElement, tiles: Json, onPick: (id: string | null, at: Point | null) => void,
                                   onStatus: (s: RenderStatus) => void) {
  const photo = await loadPhotoreal();
  const google = photo?.tileset ?? null;
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
    // ion's terms require its logo while ion serves the tiles; a direct Google key does not use ion.
    if (photo?.direct) (credits.querySelector(".cesium-credit-logoContainer") as HTMLElement | null)?.style.setProperty("display", "none");
    Object.assign(credits.style, { position: "absolute", top: "52px", left: "16px", bottom: "auto", zIndex: "5" });
    scene.primitives.add(google);
    scene.backgroundColor = Cesium.Color.fromCssColorString("#a9cbe8"); // daylight behind the thin edge of the atmosphere
    // Without a globe this is height above the ellipsoid: about 5 m above Sumida's ground.
    scene.screenSpaceCameraController.minimumZoomDistance = GROUND + 5;
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
  let radius = RADIUS.initial;
  const focus = Cesium.Cartesian3.fromDegrees(139.8187, 35.7166, GROUND);
  const focusEye = new Cesium.Cartesian3(), upEye = new Cesium.Cartesian3();
  scene.postProcessStages.add(new Cesium.PostProcessStage({
    fragmentShader: RADIUS_LENS,
    uniforms: {
      u_radius: () => radius,
      u_focus: () => Cesium.Matrix4.multiplyByPoint(camera.viewMatrix, focus, focusEye),
      u_up: () => Cesium.Matrix4.multiplyByPointAsVector(camera.viewMatrix, Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(focus), upEye),
    },
  }));

  const OPTIONS: Cesium.Cesium3DTileset.ConstructorOptions = {
    maximumScreenSpaceError: 16,
    shadows: Cesium.ShadowMode.ENABLED,
    ...STREAMING,
    // Over Google's city these only back the search overlay, so they stay light.
    ...(google ? { maximumScreenSpaceError: 64, cacheBytes: 64 * 1024 * 1024, maximumCacheOverflowBytes: 32 * 1024 * 1024 }
               : { cacheBytes: 512 * 1024 * 1024, maximumCacheOverflowBytes: 256 * 1024 * 1024 }),
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
      () => { viewer.resolutionScale = Math.min(viewer.resolutionScale, 1); scene.shadowMap.size = 2048; },
      () => { viewer.resolutionScale = 0.8; scene.msaaSamples = 1; },
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

  // The circle follows the ground point at the centre of the view. The radius itself is only ever the visitor's.
  const groundLevel = new Cesium.Ellipsoid(Cesium.Ellipsoid.WGS84.radii.x + GROUND, Cesium.Ellipsoid.WGS84.radii.y + GROUND, Cesium.Ellipsoid.WGS84.radii.z + GROUND);
  const active = google ?? buildings;
  let loading = 0, lastStatus = 0;
  let rings = [0, 0, 0, 0], shallow = Infinity, deep = -1;
  active.tileVisible.addEventListener((tile: Cesium.Cesium3DTile) => {
    const b = tile.boundingSphere, gap = (Cesium.Cartesian3.distance(b.center, focus) - b.radius - radius) / radius;
    rings[ringOf(gap)]++;
    const level = treeLevel(tile);
    if (level < shallow) shallow = level;
    if (level > deep) deep = level;
  });
  active.loadProgress.addEventListener((pending: number, processing: number) => { loading = pending + processing; });
  scene.preRender.addEventListener(() => {
    const span = Cesium.IntersectionTests.rayEllipsoid(new Cesium.Ray(camera.positionWC, camera.directionWC), groundLevel);
    if (span && span.start < 8000) {
      const hit = Cesium.Cartesian3.add(camera.positionWC, Cesium.Cartesian3.multiplyByScalar(camera.directionWC, span.start, new Cesium.Cartesian3()), new Cesium.Cartesian3());
      Cesium.Cartesian3.lerp(focus, hit, 0.12, focus);
    }
    for (const t of [google, buildings] as unknown as (RadiusTileset | null)[]) if (t) { t.renderRadius = radius; t.renderFocus = focus; }
    const now = performance.now();
    if (now - lastStatus > 500) {
      lastStatus = now;
      const c = Cesium.Cartographic.fromCartesian(focus);
      onStatus({ lon: Cesium.Math.toDegrees(c.longitude), lat: Cesium.Math.toDegrees(c.latitude), loading, memoryMB: active.totalMemoryUsageInBytes / 1e6,
                 height: camera.positionCartographic.height - GROUND, lod: rings, levels: deep >= 0 ? [shallow, deep] : null });
    }
    rings = [0, 0, 0, 0]; shallow = Infinity; deep = -1; // counted afresh for each frame
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
  // Any input hands the camera straight to the visitor, even in the middle of a flight.
  const takeOver = () => { orbit = null; camera.cancelFlight(); };
  const controls = scene.screenSpaceCameraController;
  controls.zoomEventTypes = [Cesium.CameraEventType.WHEEL, Cesium.CameraEventType.PINCH];
  controls.tiltEventTypes = [Cesium.CameraEventType.RIGHT_DRAG, Cesium.CameraEventType.MIDDLE_DRAG, Cesium.CameraEventType.PINCH,
    { eventType: Cesium.CameraEventType.LEFT_DRAG, modifier: Cesium.KeyboardEventModifier.CTRL }];
  // Keyboard flying: WASD or arrows to move, Q and E for down and up, Shift for speed.
  const held = new Set<string>();
  const typing = (e: KeyboardEvent) => e.target instanceof HTMLElement && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName);
  addEventListener("keydown", (e) => {
    if (typing(e) || e.metaKey || e.ctrlKey || !/^(Key[WASDQE]|Arrow(Up|Down|Left|Right))$/.test(e.code)) { if (e.key === "Shift") held.add("Shift"); return; }
    held.add(e.code); takeOver(); e.preventDefault();
  });
  addEventListener("keyup", (e) => { held.delete(e.code); if (e.key === "Shift") held.delete("Shift"); });
  addEventListener("blur", () => held.clear());
  let lastMove = performance.now();
  scene.preUpdate.addEventListener(() => {
    const now = performance.now(), dt = Math.min((now - lastMove) / 1000, 0.1);
    lastMove = now;
    if (held.size) {
      const up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(camera.positionWC);
      const flat = (v: Cesium.Cartesian3) => Cesium.Cartesian3.normalize(Cesium.Cartesian3.subtract(v, Cesium.Cartesian3.multiplyByScalar(up, Cesium.Cartesian3.dot(v, up), new Cesium.Cartesian3()), new Cesium.Cartesian3()), new Cesium.Cartesian3());
      const speed = Cesium.Math.clamp((camera.positionCartographic.height - GROUND) * 0.7, 15, 700) * (held.has("Shift") ? 3 : 1) * dt;
      const on = (...c: string[]) => c.some((k) => held.has(k));
      if (on("KeyW", "ArrowUp")) camera.move(flat(camera.directionWC), speed);
      if (on("KeyS", "ArrowDown")) camera.move(flat(camera.directionWC), -speed);
      if (on("KeyD", "ArrowRight")) camera.move(flat(camera.rightWC), speed);
      if (on("KeyA", "ArrowLeft")) camera.move(flat(camera.rightWC), -speed);
      if (on("KeyE")) camera.move(up, speed);
      if (on("KeyQ")) camera.move(up, -Math.min(speed, Math.max(camera.positionCartographic.height - GROUND - 5, 0)));
    }
    if (!orbit) return;
    camera.lookAtTransform(Cesium.Transforms.eastNorthUpToFixedFrame(orbit));
    camera.rotateRight(0.00035);
    camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  });
  const canvas = scene.canvas;
  for (const type of ["pointerdown", "wheel", "touchstart"]) canvas.addEventListener(type, takeOver, { passive: true, capture: true });

  new Cesium.ScreenSpaceEventHandler(canvas).setInputAction((e: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
    const hit = scene.pick(e.position);
    const spot = google && scene.pickPositionSupported ? scene.pickPosition(e.position) : undefined;
    const c = spot && Cesium.Cartographic.fromCartesian(spot);
    onPick(hit instanceof Cesium.Cesium3DTileFeature ? hit.getProperty("gml_id") ?? null : null,
           c ? { lon: Cesium.Math.toDegrees(c.longitude), lat: Cesium.Math.toDegrees(c.latitude) } : null);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  // Flood simulation: a water surface that rises per GSI's timing, plus physics particles.
  let flood: { surface: Cesium.Primitive; spray: Cesium.PointPrimitiveCollection; sim: ParticleWater; points: Cesium.PointPrimitive[]; origin: Cesium.Matrix4; toLocal: Cesium.Matrix4; field: FloodField } | null = null;
  let floodTime = 0, floodTarget = -1, floodClock = performance.now();
  function buildFlood(field: FloodField) {
    const { w, h, west, south, east, north, arrive, depthClass, elev } = field, skip = 2;
    const cols = Math.floor((w - 1) / skip) + 1, rows = Math.floor((h - 1) / skip) + 1, n = cols * rows;
    const positions = new Float64Array(n * 3), arrives = new Float32Array(n), peaks = new Float32Array(n), xyz = new Cesium.Cartesian3();
    for (let r = 0; r < rows; r++) for (let q = 0; q < cols; q++) {
      const i = q * skip, j = r * skip, c = i + j * w, v = q + r * cols;
      Cesium.Cartesian3.fromDegrees(west + ((i + 0.5) / w) * (east - west), south + ((j + 0.5) / h) * (north - south), DATUM + elev[c] / 10, undefined, xyz);
      positions.set([xyz.x, xyz.y, xyz.z], v * 3);
      arrives[v] = arrive[c] === NEVER ? 400 : arrive[c];
      peaks[v] = depthClass[c] ? peakDepth(field, c) : 0;
    }
    const indices = new Uint32Array((cols - 1) * (rows - 1) * 6);
    let k = 0;
    for (let r = 0; r < rows - 1; r++) for (let q = 0; q < cols - 1; q++) {
      const a = q + r * cols, b = a + 1, c = a + cols, d = c + 1;
      indices.set([a, b, d, a, d, c], k); k += 6;
    }
    const attribute = (componentDatatype: Cesium.ComponentDatatype, componentsPerAttribute: number, values: Float32Array | Float64Array) =>
      new Cesium.GeometryAttribute({ componentDatatype, componentsPerAttribute, values });
    const geometry = new Cesium.Geometry({
      attributes: {
        position: attribute(Cesium.ComponentDatatype.DOUBLE, 3, positions),
        arrive: attribute(Cesium.ComponentDatatype.FLOAT, 1, arrives),
        peak: attribute(Cesium.ComponentDatatype.FLOAT, 1, peaks),
      } as unknown as Cesium.GeometryAttributes,
      indices, primitiveType: Cesium.PrimitiveType.TRIANGLES,
      boundingSphere: Cesium.BoundingSphere.fromVertices(Array.from(positions)),
    });
    const centre = Cesium.Cartesian3.fromDegrees(west, south, DATUM), originM = Cesium.Transforms.eastNorthUpToFixedFrame(centre);
    const up = Cesium.Cartesian3.fromCartesian4(Cesium.Matrix4.getColumn(originM, 2, new Cesium.Cartesian4()));
    const eastAxis = Cesium.Cartesian3.fromCartesian4(Cesium.Matrix4.getColumn(originM, 0, new Cesium.Cartesian4()));
    const appearance = new Cesium.Appearance({
      translucent: true, closed: false, vertexShaderSource: WATER_VS, fragmentShaderSource: WATER_FS,
      renderState: (Cesium.Appearance as unknown as { getDefaultRenderState: (translucent: boolean, closed: boolean, extra: object) => object }).getDefaultRenderState(true, false, { cull: { enabled: false } }),
    }) as Cesium.Appearance & { uniforms: Record<string, unknown> };
    appearance.uniforms = { get u_t() { return floodTime; }, u_up: up, u_east: eastAxis };
    const surface = scene.primitives.add(new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({ geometry }), appearance,
      asynchronous: false, compressVertices: false, allowPicking: false, vertexCacheOptimize: false, show: false,
    })) as Cesium.Primitive;
    const spray = scene.primitives.add(new Cesium.PointPrimitiveCollection({ modelMatrix: originM, blendOption: Cesium.BlendOption.TRANSLUCENT })) as Cesium.PointPrimitiveCollection;
    spray.show = false;
    const sim = new ParticleWater(field, 4500), white = Cesium.Color.WHITE.withAlpha(0.8), blue = Cesium.Color.fromCssColorString("#bcd8e4").withAlpha(0.65);
    const scale = new Cesium.NearFarScalar(60, 1.5, 3500, 0.45);
    const points = Array.from({ length: sim.count }, (_, i) => spray.add({ show: false, pixelSize: i % 3 ? 3 : 4.5, color: i % 3 ? blue : white, scaleByDistance: scale }));
    flood = { surface, spray, sim, points, origin: originM, toLocal: Cesium.Matrix4.inverseTransformation(originM, new Cesium.Matrix4()), field };
  }
  const local = new Cesium.Cartesian3(), spot = new Cesium.Cartesian3();
  scene.preUpdate.addEventListener(() => {
    const now = performance.now(), dt = Math.min((now - floodClock) / 1000, 0.05);
    floodClock = now;
    if (!flood || floodTarget < 0) return;
    floodTime += (floodTarget - floodTime) * Math.min(dt * 6, 1);
    Cesium.Matrix4.multiplyByPoint(flood.toLocal, focus, local);
    const { sim, points } = flood;
    sim.step(dt, floodTime, local.x, local.y, Math.min(radius, 1500));
    const R = 6378137;
    for (let i = 0; i < sim.count; i++) {
      const alive = sim.life[i] > 0;
      if (points[i].show !== alive) points[i].show = alive;
      if (alive) {
        const dx = sim.x[i], dy = sim.y[i];
        spot.x = dx; spot.y = dy; spot.z = sim.z[i] + 0.25 - (dx * dx + dy * dy) / (2 * R); // follow the Earth's curve
        points[i].position = spot;
      }
    }
  });

  return {
    /** Show the flood at a fractional GSI time step, or remove it with null. */
    setFlood(field: FloodField | null, step = 0) {
      if (field && !flood) buildFlood(field);
      floodTarget = field ? step : -1;
      if (field && step < floodTime - 1) floodTime = step; // a restart should not drain visibly
      if (flood) flood.surface.show = flood.spray.show = !!field;
    },

    textured,
    photoreal: !!google,
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

    setRadius(metres: number) {
      radius = metres;
    },

    /** Tint each tile, to see how the hierarchy has divided the city. */
    showTiles(on: boolean) {
      active.debugColorizeTiles = on;
    },

    setLight(light: Light) {
      viewer.clock.currentTime = Cesium.JulianDate.fromIso8601(TIMES[light]);
      const l = LIGHTS[light];
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
