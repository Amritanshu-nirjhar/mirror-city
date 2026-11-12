// Animated water surface for official inundation data.
//
// Where the water is comes from published data only: GSI breach-scenario tiles for each
// time step, or PLATEAU storm-surge zones. Nothing hydraulic is simulated here. Between
// two steps the surface is blended smoothly, and for a breach scenario that blend runs
// outwards from the breach point so the water appears to pour in from the river. The
// blend, its ordering, the ripples and the reflections are visual effects only.
import * as Cesium from "cesium";
import type { Json, Point } from "./api";

const Z = 14; // 4 x 4 tiles at z14: about 8 km around the pilot area at ~8 m per pixel
const N = 4;
const TILE = 256;
export const STEP_MS = 1600; // time to blend from one step to the next
// GSI's standard flood-depth legend, shallow to deep. Used only to shade deeper water darker.
const LEGEND = [[247, 245, 169], [255, 216, 192], [255, 183, 183], [255, 145, 145], [242, 133, 201], [220, 122, 220]];
/** Mask brightness for a depth class 0..5: 0 is dry, brighter is deeper. */
export const shade = (depthClass: number) => 150 + 21 * depthClass;

// Cesium's Water material, extended to blend between two masks, optionally outwards from a point.
const SHADER = `
czm_material czm_getMaterial(czm_materialInput materialInput) {
  czm_material material = czm_getDefaultMaterial(materialInput);
  vec2 st = materialInput.st;
  float time = czm_frameNumber * animationSpeed;
  float a = texture(maskA, st).r;
  float b = texture(maskB, st).r;
  float older = mix(a, b, flip);
  float newer = mix(b, a, flip);
  // With spread > 0 the change reaches places near the origin first.
  float local = clamp(progress * (1.0 + spread * 2.4) - spread * 1.6 * distance(st, origin), 0.0, 1.0);
  // Wide, soft masks: thresholding their blend makes the shoreline travel instead of just fading.
  float m = mix(older, newer, local);
  float wet = smoothstep(0.30, 0.46, m);
  float depth = smoothstep(0.45, 1.0, m);
  vec4 noise = czm_getWaterNoise(normalMap, st * frequency, time, 0.6);
  vec3 n = noise.xyz * vec3(1.0, 1.0, 1.0 / amplitude);
  n = normalize(mix(vec3(0.0, 0.0, 50.0), n, wet));
  float perturbation = clamp(dot(n, vec3(0.0, 0.0, 1.0)), 0.0, 1.0);
  // A thin bright fringe where the water is arriving.
  float front = wet * (1.0 - smoothstep(0.46, 0.62, m));
  material.diffuse = mix(shallowColor.rgb, deepColor.rgb, depth) + 0.1 * perturbation + 0.18 * front;
  material.alpha = mix(shallowColor.a, deepColor.a, depth) * wet;
  material.normal = normalize(materialInput.tangentToEyeMatrix * n);
  material.specular = specularIntensity;
  material.shininess = 10.0;
  return material;
}`;

/** One state of the water. `paint` draws grey levels (see `shade`) onto a black canvas. */
export interface WaterStep {
  key: string;
  origin?: Point; // where the water comes from, if known
  paint: (ctx: CanvasRenderingContext2D, grid: Grid) => Promise<void>;
}
interface Grid {
  x0: number;
  y0: number;
  toPixel: (lon: number, lat: number) => [number, number];
}

function loadTile(url: string) {
  return new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null); // tiles outside the flooded area do not exist
    setTimeout(() => resolve(null), 8000); // never let one stalled tile hold up the whole step
    img.src = url;
  });
}

/** A published GSI time step: stitch its tiles and turn legend colours into depth shades. */
export function gsiStep(template: string, minutes: number, origin?: Point): WaterStep {
  return {
    key: `${template}@${minutes}`,
    origin,
    async paint(ctx, { x0, y0 }) {
      const base = template.replace("{time}", String(minutes).padStart(5, "0")).replace("{z}", String(Z));
      const tiles = await Promise.all(
        Array.from({ length: N * N }, (_, i) =>
          loadTile(base.replace("{x}", String(x0 + (i % N))).replace("{y}", String(y0 + Math.floor(i / N)))),
        ),
      );
      ctx.clearRect(0, 0, N * TILE, N * TILE);
      tiles.forEach((img, i) => img && ctx.drawImage(img, (i % N) * TILE, Math.floor(i / N) * TILE));
      const px = ctx.getImageData(0, 0, N * TILE, N * TILE);
      const d = px.data;
      for (let i = 0; i < d.length; i += 4) {
        let v = 0;
        if (d[i + 3] > 40) {
          let best = 0, bestD = Infinity;
          LEGEND.forEach(([r, g, b], k) => {
            const dist = (d[i] - r) ** 2 + (d[i + 1] - g) ** 2 + (d[i + 2] - b) ** 2;
            if (dist < bestD) [best, bestD] = [k, dist];
          });
          v = shade(best);
        }
        d[i] = d[i + 1] = d[i + 2] = v;
        d[i + 3] = 255;
      }
      ctx.putImageData(px, 0, 0);
    },
  };
}

/** Hazard-zone polygons (GeoJSON from the backend) whose rank is at least `minRank`. */
export function zoneStep(key: string, fc: Json, minRank: number, shadeOf = (rank: number) => shade(rank - 1)): WaterStep {
  return {
    key,
    async paint(ctx, { toPixel }) {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, N * TILE, N * TILE);
      // Shallow first so deeper zones paint over them.
      const feats = [...fc.features].sort((p: Json, q: Json) => p.properties.hazard_rank - q.properties.hazard_rank);
      for (const f of feats) {
        const rank = Number(f.properties.hazard_rank);
        if (rank < minRank) continue;
        const v = Math.round(shadeOf(rank));
        ctx.fillStyle = `rgb(${v},${v},${v})`;
        ctx.beginPath();
        for (const poly of f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates) {
          for (const ring of poly) {
            ring.forEach(([lon, lat]: number[], i: number) => {
              const [x, y] = toPixel(lon, lat);
              if (i) ctx.lineTo(x, y);
              else ctx.moveTo(x, y);
            });
            ctx.closePath();
          }
        }
        ctx.fill("evenodd");
      }
    },
  };
}

export function createWater(viewer: Cesium.Viewer, centre: Point) {
  const n = 2 ** Z;
  const mercY = (lat: number) => {
    const r = Cesium.Math.toRadians(lat);
    return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  };
  const tileX = (lon: number) => ((lon + 180) / 360) * n;
  const x0 = Math.round(tileX(centre.lon)) - N / 2;
  const y0 = Math.round(mercY(centre.lat)) - N / 2;
  const lon = (x: number) => (x / n) * 360 - 180;
  const lat = (y: number) => Cesium.Math.toDegrees(Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))));
  const grid: Grid = { x0, y0, toPixel: (lo, la) => [(tileX(lo) - x0) * TILE, (mercY(la) - y0) * TILE] };

  const raw = document.createElement("canvas");
  const mask = document.createElement("canvas");
  raw.width = raw.height = mask.width = mask.height = N * TILE;
  const rawCtx = raw.getContext("2d", { willReadFrequently: true })!;
  const maskCtx = mask.getContext("2d")!;
  maskCtx.fillStyle = "#000";
  maskCtx.fillRect(0, 0, mask.width, mask.height);
  const dry = mask.toDataURL();

  const material = new Cesium.Material({
    fabric: {
      uniforms: {
        maskA: dry,
        maskB: dry,
        flip: 0, // 0: A is the older step and B the newer; 1: the other way round
        progress: 1,
        origin: new Cesium.Cartesian2(0.5, 0.5),
        spread: 0,
        deepColor: new Cesium.Color(0.05, 0.22, 0.36, 0.94),
        shallowColor: new Cesium.Color(0.3, 0.56, 0.66, 0.8),
        normalMap: Cesium.buildModuleUrl("Assets/Textures/waterNormals.jpg"),
        frequency: 3500,
        animationSpeed: 0.012,
        amplitude: 6,
        specularIntensity: 1,
      },
      source: SHADER,
    },
    translucent: true,
  });
  const primitive = viewer.scene.groundPrimitives.add(
    new Cesium.GroundPrimitive({
      geometryInstances: new Cesium.GeometryInstance({
        geometry: new Cesium.RectangleGeometry({
          rectangle: Cesium.Rectangle.fromDegrees(lon(x0), lat(y0 + N), lon(x0 + N), lat(y0)),
          vertexFormat: Cesium.EllipsoidSurfaceAppearance.VERTEX_FORMAT,
        }),
      }),
      appearance: new Cesium.EllipsoidSurfaceAppearance({ material, aboveGround: false }),
      classificationType: Cesium.ClassificationType.TERRAIN, // water lies on the ground; buildings stand in it
      show: false,
    }),
  );

  let generation = 0; // bumped when the water is cleared
  let pending: WaterStep | null = null;
  let busy = false;
  const masks = new Map<string, string>(); // built masks, so replays are instant
  let visible = true;
  let active = false;
  let newest = 0; // which mask slot (0 = A, 1 = B) holds the newest step
  let raf = 0;
  const apply = () => {
    primitive.show = visible && active;
    // Ripples need a frame every tick; everything else renders on demand.
    viewer.scene.requestRenderMode = !primitive.show;
    viewer.scene.requestRender();
  };

  function animate() {
    cancelAnimationFrame(raf);
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min((now - start) / STEP_MS, 1);
      material.uniforms.progress = t; // linear, so consecutive steps join without a pause
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  async function buildMask(step: WaterStep) {
    await step.paint(rawCtx, grid);
    maskCtx.filter = "blur(5px)"; // ~40 m of soft edge for the travelling shoreline
    maskCtx.drawImage(raw, 0, 0);
    return mask.toDataURL();
  }

  return {
    /** Water blues, or a matte amber-to-red heat surface for ground shaking. */
    setPalette(heat: boolean) {
      const u = material.uniforms;
      u.shallowColor = heat ? new Cesium.Color(0.98, 0.72, 0.2, 0.5) : new Cesium.Color(0.3, 0.56, 0.66, 0.8);
      u.deepColor = heat ? new Cesium.Color(0.86, 0.16, 0.1, 0.82) : new Cesium.Color(0.05, 0.22, 0.36, 0.94);
      u.specularIntensity = heat ? 0 : 1;
    },
    setVisible(on: boolean) {
      visible = on;
      apply();
    },
    /** Blend towards a new state of the water, or clear it with null. */
    async update(step: WaterStep | null) {
      if (!step) {
        generation++;
        pending = null;
        active = false;
        cancelAnimationFrame(raf);
        material.uniforms.maskA = material.uniforms.maskB = dry;
        material.uniforms.progress = 1;
        return apply();
      }
      // Latest wins: a step that is still loading is always shown before moving on, and
      // steps that arrive meanwhile collapse into the newest one.
      pending = step;
      if (busy) return;
      busy = true;
      const mine = generation;
      while (pending && mine === generation) {
        const next: WaterStep = pending;
        pending = null;
        const url = masks.get(next.key) ?? (await buildMask(next));
        masks.set(next.key, url);
        if (mine !== generation) break;
        // Put the new step in the slot that is currently hidden, then blend towards it.
        cancelAnimationFrame(raf);
        newest = 1 - newest;
        material.uniforms[newest ? "maskB" : "maskA"] = url;
        material.uniforms.flip = newest ? 0 : 1;
        material.uniforms.progress = 0;
        if (next.origin) {
          const [px, py] = grid.toPixel(next.origin.lon, next.origin.lat);
          material.uniforms.origin = new Cesium.Cartesian2(px / (N * TILE), 1 - py / (N * TILE));
        }
        material.uniforms.spread = next.origin ? 1 : 0;
        active = true;
        apply();
        await new Promise((r) => setTimeout(r, 120)); // let the texture upload first
        if (mine !== generation) break;
        animate();
        if (pending) await new Promise((r) => setTimeout(r, STEP_MS)); // finish this blend before the next
      }
      busy = false;
    },
  };
}
