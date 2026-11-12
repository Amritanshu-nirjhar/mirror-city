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

export async function api(path: string, params: Record<string, string | number> = {}): Promise<Json> {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const res = await fetch(`/api${path}${qs.size ? `?${qs}` : ""}`);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.detail ?? `Request failed (${res.status})`);
  return body;
}
