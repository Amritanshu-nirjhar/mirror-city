"""GSI Inundation Navi (浸水ナビ) client.

All JSON calls are made here, on the backend: cached in api_cache, throttled below the GSI
guidance of ~30 requests/minute, with timeouts and bounded retries. Nothing in this module
invents data: empty upstream answers stay empty and are labelled as such.
"""
import ssl
import threading
import time
from datetime import timedelta
from urllib.parse import urlencode

import httpx
from psycopg.types.json import Jsonb

from .db import row, rows

API = "https://suiboumap.gsi.go.jp/shinsuimap/Api/Public/"
TILES = "https://suiboumap.gsi.go.jp/shinsuimap/Tile"
MIN_INTERVAL = 2.1  # seconds between upstream calls: at most ~28 per minute
RETRIES = 2
CACHE_TTL = timedelta(days=7)  # published scenarios are static data
# CSVScale -> (tile folder, label). Unclassified data has no confirmed tile folder.
SCALES = {0: ("L2", "L2 — maximum assumed rainfall"),
          1: ("L1", "L1 — planned rainfall"),
          -1: (None, "Unclassified historical data")}
DISCLAIMER = ("Hypothetical breach scenario published by GSI Inundation Navi. "
              "It is not live weather, a forecast or an ongoing flood.")
POINT_NOTE = ("Depth is sampled at one point (the building's representative point). "
              "It is not a whole-building water-depth calculation.")
NO_DATA_NOTE = ("GSI returned no depth for this point and time. That is not proof of dry conditions: "
                "the flood may not have arrived yet, or the scenario may not cover this point.")

# The GSI server does not support RFC 5746 secure renegotiation, which OpenSSL 3 refuses by
# default. This allows the connection; certificate verification stays on.
_tls = ssl.create_default_context()
_tls.options |= ssl.OP_LEGACY_SERVER_CONNECT
_client = httpx.Client(timeout=15, verify=_tls, headers={"User-Agent": "mirror-city/1.0"})
_lock = threading.Lock()
_last_call = 0.0


class UpstreamError(Exception):
    pass


def fetch(endpoint, **params):
    """GET one GSI endpoint. Returns (json, source) where source records provenance."""
    global _last_call
    key = f"gsi:{endpoint}?{urlencode(sorted(params.items()))}"
    hit = row("SELECT response_json, fetched_at FROM api_cache WHERE request_key = %s AND expires_at > now()", (key,))
    if not hit:
        with _lock:  # serialises upstream calls so the rate limit holds across requests
            for attempt in range(RETRIES + 1):
                time.sleep(max(0, _last_call + MIN_INTERVAL - time.monotonic()))
                _last_call = time.monotonic()
                try:
                    r = _client.get(API + endpoint, params=params)
                    if r.status_code < 500:
                        break
                    error = f"HTTP {r.status_code}"
                except httpx.TransportError as e:
                    error = type(e).__name__
            else:
                raise UpstreamError(f"GSI {endpoint} unavailable after {RETRIES + 1} attempts ({error})")
        if r.status_code != 200:
            raise UpstreamError(f"GSI {endpoint} returned HTTP {r.status_code}")
        try:
            data = r.json()
        except ValueError:
            raise UpstreamError(f"GSI {endpoint} returned a non-JSON response")
        hit = row("""INSERT INTO api_cache (request_key, response_json, expires_at) VALUES (%s, %s, now() + %s)
                     ON CONFLICT (request_key) DO UPDATE SET (response_json, fetched_at, expires_at) =
                         (EXCLUDED.response_json, now(), EXCLUDED.expires_at)
                     RETURNING response_json, fetched_at""", (key, Jsonb(data), CACHE_TTL))
    return hit["response_json"], {"provider": "GSI Inundation Navi (浸水ナビ)", "endpoint": API + endpoint,
                                  "params": params, "fetched_at": hit["fetched_at"]}


def tile_template(office_code, scale, river_code, sub_river_code, breach_name):
    """Raster tile URL for one scenario; `{time}` is the elapsed minutes padded to 5 digits."""
    folder = SCALES.get(scale, (None,))[0]
    if not (folder and office_code and river_code and breach_name):
        return None
    river = river_code if sub_river_code in (None, "", "_") else f"{river_code}{sub_river_code}"
    return f"{TILES}/{office_code}/{folder}/{river}/{breach_name}/{breach_name}_{{time}}m/{{z}}/{{x}}/{{y}}.png"


def tile_url(template, minutes, z, x, y):
    return template.format(time=f"{minutes:05d}", z=z, x=x, y=y)


def scenarios(lon, lat):
    raw, source = fetch("GetBreakPoint", lon=lon, lat=lat)
    out = []
    for s in raw if isinstance(raw, list) else []:
        scale = s.get("CSVScale")
        out.append({
            "id": s["ID"], "breach_name": s.get("BPName"), "breach_location": s.get("BPLocation"),
            "breach_lon": s.get("BPLon"), "breach_lat": s.get("BPLat"),
            "river_name": s.get("EntryRiverName"),
            "rainfall_scale": scale, "rainfall_label": SCALES.get(scale, (None, f"Unknown scale {scale}"))[1],
            "office_code": s.get("OfficeCode"), "river_code": s.get("RiverCode"),
            "sub_river_code": s.get("SubRiverCode"),
            "time_steps": s.get("BPTime") or [],
            "tile_url_template": tile_template(s.get("OfficeCode"), scale, s.get("RiverCode"),
                                               s.get("SubRiverCode"), s.get("BPName")),
            "flags": {k: s[k] for k in ("isDepthMax", "isStartMax", "isDurationMax") if k in s},
        })
        row("""INSERT INTO flood_scenarios (gsi_breach_id, breach_name, river_name, breach_location, office_code,
                   river_code, sub_river_code, rainfall_scale, time_steps, metadata_json)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT (gsi_breach_id) DO UPDATE SET (time_steps, metadata_json) =
                   (EXCLUDED.time_steps, EXCLUDED.metadata_json) RETURNING id""",
            (s["ID"], s.get("BPName"), s.get("EntryRiverName"), s.get("BPLocation"), s.get("OfficeCode"),
             s.get("RiverCode"), s.get("SubRiverCode"), scale, s.get("BPTime") or [], Jsonb(s)))
    return {"scenarios": out, "point": {"lon": lon, "lat": lat}, "source": source, "disclaimer": DISCLAIMER,
            "message": None if out else "GSI publishes no breach scenario that reaches this point."}


def known_scenario(breach_id):
    return row("SELECT gsi_breach_id, breach_name, time_steps FROM flood_scenarios WHERE gsi_breach_id = %s", (breach_id,))


def normalise_hydrograph(raw):
    """GSI gives the series in hours and the summary fields in minutes; return minutes throughout."""
    raw = raw if isinstance(raw, dict) else {}
    info = raw.get("info") or {}
    # Hours are published to 2 decimals (0.17 h = 10 min), so rounding recovers whole minutes exactly.
    series = [{"minutes": round(h * 60), "depth_m": d} for h, d in raw.get("data") or []]
    return {
        "covered": bool(series),
        "series": series,
        "arrival_minutes": info.get("StartTime"),
        "max_depth_m": info.get("Depth_Max"),
        "time_of_max_minutes": info.get("ShinSuiTime_Max"),
        "duration_minutes": {k: v for k, v in info.items() if k.startswith("Time_")},
        "units": {"time": "minutes since breach", "depth": "metres"},
        "breach": raw.get("bp"),
    }


def hydrograph(breach_id, lon, lat):
    raw, source = fetch("GetHydrographData", lon=lon, lat=lat, bpid=breach_id)
    out = normalise_hydrograph(raw)
    out.update(point={"lon": lon, "lat": lat}, source=source, disclaimer=DISCLAIMER, sample_note=POINT_NOTE,
               message=None if out["covered"] else "The selected scenario has no published hydrograph at this point.")
    return out


def depth(breach_id, lon, lat, minutes=None):
    if minutes is None:
        raw, source = fetch("GetMaxDepth", lon=lon, lat=lat, bpid=breach_id)
    else:
        raw, source = fetch("GetMaxDepthByTime", lon=lon, lat=lat, bptime=minutes, bpid=breach_id)
    value = raw.get("Depth") if isinstance(raw, dict) else None
    return {"depth_m": value, "status": "ok" if value is not None else "no_data",
            "kind": "scenario_maximum" if minutes is None else "at_time", "minutes": minutes,
            "note": None if value is not None else NO_DATA_NOTE,
            "point": {"lon": lon, "lat": lat}, "source": source, "disclaimer": DISCLAIMER, "sample_note": POINT_NOTE}
