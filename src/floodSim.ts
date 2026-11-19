// Water particles for the flood simulation. Where and when water exists comes from the baked GSI
// scenario; each particle then follows simple physics: it is pushed along the direction the flood
// spreads, keeps its momentum, feels drag and gravity, and bounces off real building footprints.
export interface FloodField {
  w: number; h: number; cell: number; west: number; south: number; east: number; north: number;
  steps: number[]; scenario: string; breach: string; // GSI breach id, for the server's simulators
  arrive: Uint8Array; depthClass: Uint8Array; elev: Int8Array; building: Uint8Array;
}
export const NEVER = 255;
const CLASS_DEPTH = [0, 0.25, 1.75, 4, 7.5, 15, 30]; // middle of each GSI depth class, metres
const GRAVITY = 9.8, DRAG = 1.6, TIME_LAPSE = 7; // the flood plays far faster than life, so flow does too

export async function loadFloodField(): Promise<FloodField> {
  const [meta, bin] = await Promise.all([
    fetch("/flood-field.json").then((r) => { if (!r.ok) throw new Error("The flood data could not be loaded."); return r.json(); }),
    fetch("/flood-field.bin").then((r) => { if (!r.ok) throw new Error("The flood data could not be loaded."); return r.arrayBuffer(); }),
  ]);
  const n = meta.w * meta.h;
  return { ...meta, arrive: new Uint8Array(bin, 0, n), depthClass: new Uint8Array(bin, n, n),
           elev: new Int8Array(bin, 2 * n, n), building: new Uint8Array(bin, 3 * n, n) };
}

/** Water depth in a cell at scenario time t (fractional step): it rises over three steps after arriving. */
export function depthAt(f: FloodField, c: number, t: number) {
  const a = f.arrive[c];
  return a === NEVER || t < a ? 0 : CLASS_DEPTH[f.depthClass[c]] * Math.min((t - a + 0.25) / 3, 1);
}
export const peakDepth = (f: FloodField, c: number) => CLASS_DEPTH[f.depthClass[c]];

export class ParticleWater {
  x: Float32Array; y: Float32Array; z: Float32Array; vx: Float32Array; vy: Float32Array; vz: Float32Array; life: Float32Array;
  f: FloodField; count: number; rnd: () => number;
  private fx: Float32Array; private fy: Float32Array;
  constructor(f: FloodField, count: number, rnd = Math.random) {
    this.f = f; this.count = count; this.rnd = rnd;
    this.x = new Float32Array(count); this.y = new Float32Array(count); this.z = new Float32Array(count);
    this.vx = new Float32Array(count); this.vy = new Float32Array(count); this.vz = new Float32Array(count);
    this.life = new Float32Array(count);
    const { w, h, arrive } = f, n = w * h;
    this.fx = new Float32Array(n); this.fy = new Float32Array(n);
    // Flow runs from cells flooded earlier towards cells flooded later.
    for (let j = 1; j < h - 1; j++) for (let i = 1; i < w - 1; i++) {
      const c = i + j * w, a = arrive[c];
      if (a === NEVER) continue;
      const at = (k: number) => (arrive[k] === NEVER ? a : arrive[k]);
      const gx = at(c + 1) - at(c - 1), gy = at(c + w) - at(c - w), g = Math.hypot(gx, gy);
      if (g > 0) { this.fx[c] = gx / g; this.fy[c] = gy / g; }
    }
  }
  cell(x: number, y: number) {
    const i = Math.floor(x / this.f.cell), j = Math.floor(y / this.f.cell);
    return i < 1 || j < 1 || i >= this.f.w - 1 || j >= this.f.h - 1 ? -1 : i + j * this.f.w;
  }
  surface(c: number, t: number) { return this.f.elev[c] / 10 + depthAt(this.f, c, t); }

  private spawn(p: number, t: number, cx: number, cy: number, radius: number) {
    const { f, rnd } = this;
    let best = -1, bx = 0, by = 0;
    for (let k = 0; k < 10; k++) { // prefer the advancing front
      const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * radius, x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r, c = this.cell(x, y);
      if (c < 0 || f.building[c] || f.arrive[c] === NEVER || f.arrive[c] > t) continue;
      best = c; bx = x; by = y;
      if (t - f.arrive[c] < 2) break;
    }
    if (best < 0) { this.life[p] = 0; return; }
    const front = t - f.arrive[best] < 2, speed = (1 + peakDepth(f, best) * 0.35) * TIME_LAPSE * (front ? 1.5 : 0.6);
    this.x[p] = bx; this.y[p] = by; this.z[p] = this.surface(best, t) + 0.1;
    this.vx[p] = this.fx[best] * speed; this.vy[p] = this.fy[best] * speed;
    this.vz[p] = front ? 2 + rnd() * 7 : rnd() * 1.2;
    this.life[p] = 1.2 + rnd() * 2.6;
  }

  step(dt: number, t: number, cx: number, cy: number, radius: number) {
    const { f, count, x, y, z, vx, vy, vz, life, fx, fy, rnd } = this;
    for (let p = 0; p < count; p++) {
      life[p] -= dt;
      if (life[p] <= 0) { this.spawn(p, t, cx, cy, radius); continue; }
      const c = this.cell(x[p], y[p]);
      if (c < 0 || f.arrive[c] === NEVER || f.arrive[c] > t) { life[p] = 0; continue; }
      const push = (1 + peakDepth(f, c) * 0.35) * TIME_LAPSE, turb = 5;
      vx[p] += ((fx[c] * push - vx[p]) * DRAG + (rnd() - 0.5) * turb * 4) * dt;
      vy[p] += ((fy[c] * push - vy[p]) * DRAG + (rnd() - 0.5) * turb * 4) * dt;
      vz[p] -= GRAVITY * dt;
      const nx = x[p] + vx[p] * dt, ny = y[p] + vy[p] * dt, n = this.cell(nx, ny);
      if (n >= 0 && f.building[n]) { // bounce off the wall and throw up spray
        const hitX = f.building[this.cell(nx, y[p])] === 1, hitY = f.building[this.cell(x[p], ny)] === 1;
        if (hitX || !hitY) vx[p] *= -0.45;
        if (hitY || !hitX) vy[p] *= -0.45;
        vz[p] = Math.max(vz[p], 1.5 + Math.hypot(vx[p], vy[p]) * 0.22);
      } else { x[p] = nx; y[p] = ny; }
      z[p] += vz[p] * dt;
      const level = this.surface(c, t);
      if (z[p] < level) { z[p] = level; vz[p] = Math.abs(vz[p]) * 0.22; }
    }
  }
}
