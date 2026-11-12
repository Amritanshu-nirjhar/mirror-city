"""Toei Bus stops and weekday service levels from the operator's open GTFS-JP timetable.

One row per named stop (its poles in both directions are added together). Rail stations come
from ingest_network: only Toei publishes an open timetable here, so rail has locations only.

Run: python -m ingestion.ingest_transit      (after ingest_network)
"""
import collections
import csv
import io
import os
import urllib.request
import zipfile

import psycopg

from .discover_plateau import DATA
from .ingest_network import EXTENT, SCHEMA, UA, source

FEED = "https://api-public.odpt.org/api/v4/files/Toei/data/ToeiBus-GTFS.zip"
CATALOGUE = "https://ckan.odpt.org/dataset/b_bus_gtfs_jp-toei"
DAY_START, DAY_END = 7, 19  # the daytime window for the per-hour figure


def table(feed, name):
    return csv.DictReader(io.TextIOWrapper(feed.open(name), "utf-8-sig"))


def service_levels(feed, poles):
    """Weekday departures per pole: {stop_id: [all day, daytime]} and the route names serving it."""
    weekday = {r["service_id"] for r in table(feed, "calendar.txt") if r["monday"] == "1"}
    names = {r["route_id"]: r["route_short_name"] for r in table(feed, "routes.txt")}
    trips = {r["trip_id"]: names[r["route_id"]] for r in table(feed, "trips.txt") if r["service_id"] in weekday}
    counts, routes = collections.defaultdict(lambda: [0, 0]), collections.defaultdict(set)
    for r in table(feed, "stop_times.txt"):
        if r["stop_id"] in poles and r["trip_id"] in trips and r["pickup_type"] != "1":
            counts[r["stop_id"]][0] += 1
            counts[r["stop_id"]][1] += DAY_START <= int(r["departure_time"].split(":")[0]) < DAY_END
            routes[r["stop_id"]].add(trips[r["trip_id"]])
    return counts, routes


def main():
    path = DATA / "ToeiBus-GTFS.zip"
    if not path.exists():
        with urllib.request.urlopen(urllib.request.Request(FEED, headers=UA), timeout=180) as r:
            path.write_bytes(r.read())
    feed = zipfile.ZipFile(path)
    w, s, e, n = EXTENT
    stops = [r for r in table(feed, "stops.txt") if w <= float(r["stop_lon"]) <= e and s <= float(r["stop_lat"]) <= n]
    poles = {r["stop_id"]: r["parent_station"] or r["stop_id"] for r in stops if r["location_type"] in ("", "0")}
    counts, routes = service_levels(feed, poles)
    info = next(table(feed, "feed_info.txt"))

    with psycopg.connect(os.environ["DATABASE_URL"]) as conn, conn.cursor() as cur:
        cur.execute(SCHEMA.read_text())
        src = source(cur, "東京都交通局 (Toei) / 公共交通オープンデータセンター", "都営バス GTFS-JP", CATALOGUE, CATALOGUE,
                     {"feed": FEED, "feed_version": info["feed_version"], "extent": EXTENT,
                      "service_day": "services that run on Mondays", "daytime_window": [DAY_START, DAY_END]})
        cur.execute("DELETE FROM transit_stops WHERE mode = 'bus'")
        by_parent = collections.defaultdict(list)
        for pole, parent in poles.items():
            by_parent[parent].append(pole)
        located = {r["stop_id"]: r for r in stops}
        for parent, members in by_parent.items():
            at = located.get(parent) or located[members[0]]
            cur.execute("""INSERT INTO transit_stops (stop_id, name, mode, operator, lon, lat, weekday_departures,
                               daytime_per_hour, routes, source_id) VALUES (%s, %s, 'bus', '都営バス', %s, %s, %s, %s, %s, %s)""",
                        (parent, at["stop_name"], float(at["stop_lon"]), float(at["stop_lat"]),
                         sum(counts[p][0] for p in members),
                         sum(counts[p][1] for p in members) / (DAY_END - DAY_START),
                         sorted(set().union(*(routes[p] for p in members))), src))
        cur.execute("""SELECT count(*), count(*) FILTER (WHERE weekday_departures > 0), max(weekday_departures)
                       FROM transit_stops WHERE mode = 'bus'""")
        print("bus stops: %s, with weekday service: %s, busiest: %s departures a weekday" % cur.fetchone())


if __name__ == "__main__":
    main()
