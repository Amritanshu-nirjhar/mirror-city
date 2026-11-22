// Thin client for the Mirror City backend. Payloads mirror the API JSON.
export type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface Scenario {
  id: string;
  breach_name: string;
  breach_location: string;
  river_name: string;
  rainfall_scale: number;
  rainfall_label: string;
  time_steps: number[];
  tile_url_template: string | null;
  flags?: { isDepthMax?: boolean };
  breach_lon?: number;
  breach_lat?: number;
  /** Set for the zone modes (storm surge, earthquake shaking), which have stages instead of published times. */
  stages?: { rank: string; label: string }[];
  zoneType?: "storm_surge" | "earthquake_shaking";
}

export interface Point {
  lon: number;
  lat: number;
}

// The simulators' answers are megabytes that only change when ingestion reruns, so the browser keeps
// them: parsed in memory for this visit, and in Cache Storage for a day across visits.
const KEEP = /^\/(evacuation|transit|solar|water|roads)/;
const STORE = "mirror-city-api-v1"; // bump to drop every visitor's copy after re-ingesting
const DAY = 86_400_000;
const memory = new Map<string, Promise<Json>>();

async function load(url: string, keep: boolean): Promise<Json> {
  // Cache Storage is missing on insecure origins and can refuse in private windows; then just fetch.
  const store = keep && typeof caches !== "undefined" ? await caches.open(STORE).catch(() => null) : null;
  const hit = await store?.match(url).catch(() => undefined);
  if (hit && Date.now() - Number(hit.headers.get("x-saved")) < DAY) return hit.json();
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail ?? `Request failed (${res.status})`);
  }
  const text = await res.text();
  store?.put(url, new Response(text, { headers: { "content-type": "application/json", "x-saved": String(Date.now()) } })).catch(() => {});
  return JSON.parse(text);
}

export function api(path: string, params: Record<string, string | number> = {}): Promise<Json> {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const url = `/api${path}${qs.size ? `?${qs}` : ""}`;
  if (!KEEP.test(path)) return load(url, false);
  let answer = memory.get(url);
  if (!answer) {
    answer = load(url, true);
    memory.set(url, answer);
    answer.catch(() => memory.delete(url)); // a failure is retried next time
  }
  return answer;
}
