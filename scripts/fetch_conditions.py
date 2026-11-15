#!/usr/bin/env python3
"""Collect the inputs for LineCheck's rough visibility estimate. Runs every 6 hours in GitHub Actions.

Writes data/app/conditions.json:
  sat:     recent satellite water clarity (Kd490, 1/m) for nearshore grid cells: [lon, lat, kd, age_days]
  points:  per coastal sample point, 3-hourly forecast for 72 h (wave height m, wave period s,
           wind kt, wind dir deg, sea surface temp C) + rain in the past 72 h (mm)
  reports: recent public diver reports (rounded locations), spam-filtered
Nothing here is regulatory, so this file is published automatically.
"""
import csv, io, json, math, os, re, statistics, sys, time, datetime as dt
import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "app", "conditions.json")
PTS = json.load(open(os.path.join(ROOT, "data", "manual", "coast_points.json")))  # [lon, lat]
CFG_PATH = os.path.join(ROOT, "data", "manual", "reports_config.json")
S = requests.Session()
S.headers["User-Agent"] = "LineCheck conditions (https://github.com/erikloken87/linecheck)"
now = dt.datetime.now(dt.timezone.utc)
log = {"started": now.isoformat(timespec="seconds")}


def get(url, **kw):
    for i in range(3):
        try:
            r = S.get(url, timeout=120, **kw)
            if r.status_code == 200:
                return r
            print("  HTTP", r.status_code, url[:160])
        except Exception as e:
            print("  err", e, url[:160])
        time.sleep(4 * (i + 1))
    return None


def near_coast(lon, lat, km=6.0):
    k = 111.32 * math.cos(math.radians(lat))
    for p in PTS:
        if abs(p[1] - lat) < 0.07 and math.hypot((p[0] - lon) * k, (p[1] - lat) * 110.57) <= km:
            return True
    return False


# ------------------------------------------------------------------ satellite Kd490 (NOAA CoastWatch ERDDAP)
ERDDAPS = ["https://coastwatch.pfeg.noaa.gov/erddap", "https://coastwatch.noaa.gov/erddap"]


def find_kd490():
    cands = []
    for base in ERDDAPS:
        r = get(f"{base}/search/index.json", params={"page": 1, "itemsPerPage": 200, "searchFor": "kd490"})
        if not r:
            continue
        j = r.json()["table"]
        cols = j["columnNames"]
        for row in j["rows"]:
            d = dict(zip(cols, row))
            title, did = d.get("Title", ""), d.get("Dataset ID", "")
            if not d.get("griddap"):
                continue
            t = title.lower()
            daily = "daily" in t or "1day" in did.lower() or "1-day" in t
            if not daily or "climatolog" in t or "monthly" in t or "8-day" in t or "science quality" in t:
                continue
            score = (("near real" in t or "nrt" in t) * 4 + ("viirs" in t) * 2 + ("750" in t or "0.0125" in t or "1.8 km" in t or "2km" in t) * 3
                     + ("4km" in t or "0.0417" in t) * 1 - ("global" in t and "west" not in t) * 0)
            cands.append((score, base, did, title))
    cands.sort(reverse=True)
    log["kd490_candidates"] = [c[2:] for c in cands[:10]]
    return cands


def fetch_kd490(base, did):
    info = get(f"{base}/info/{did}/index.json")
    if not info:
        return None
    rows = info.json()["table"]["rows"]
    var = next((r[1] for r in rows if r[0] == "variable" and "kd" in r[1].lower()), None)
    dims = [r[1] for r in rows if r[0] == "dimension"]
    if not var:
        return None
    # last ~5 days, CA box; stride so cells are ~2-4 km
    lat_res = None
    for r in rows:
        if r[0] == "attribute" and r[1] == "latitude" and r[2] == "actual_range":
            pass
    parts = []
    for d in dims:
        if d == "time":
            parts.append("[(last-4):1:(last)]")
        elif d in ("altitude", "depth", "zlev"):
            parts.append("[0]")
        elif d == "latitude":
            parts.append("[(32.4):STRIDE:(42.1)]")
        elif d == "longitude":
            parts.append("[(-125.0):STRIDE:(-117.0)]")
    # pick stride from resolution
    res = 0.0125
    for r in rows:
        if r[0] == "attribute" and r[1] == "NC_GLOBAL" and r[2] in ("geospatial_lat_resolution",):
            try:
                res = abs(float(re.findall(r"[\d.]+", r[4])[0]))
            except Exception:
                pass
    stride = max(1, round(0.025 / res))
    q = var + "".join(parts).replace("STRIDE", str(stride))
    # latitude may be stored north->south; ERDDAP accepts either order only matching storage, so try both
    for attempt in (q, q.replace("(32.4):", "(42.1):").replace(":(42.1)]", ":(32.4)]", 1)):
        r = get(f"{base}/griddap/{did}.csv", params=None) if False else get(f"{base}/griddap/{did}.csv?{attempt}")
        if r and len(r.text) > 1000:
            return var, r.text, stride, res
    return None


sat, sat_meta = [], {}
for score, base, did, title in find_kd490()[:6]:
    print("[kd490] trying", did, "|", title)
    got = fetch_kd490(base, did)
    if not got:
        continue
    var, text, stride, res = got
    rd = csv.reader(io.StringIO(text))
    header = next(rd); next(rd)  # units row
    ti, yi, xi, vi = header.index("time"), header.index("latitude"), header.index("longitude"), header.index(var)
    best = {}
    for row in rd:
        try:
            v = float(row[vi])
        except ValueError:
            continue
        if not (0.01 < v < 6):
            continue
        lat, lon = float(row[yi]), float(row[xi])
        if not near_coast(lon, lat):
            continue
        t = dt.datetime.fromisoformat(row[ti].replace("Z", "+00:00"))
        key = (round(lon, 3), round(lat, 3))
        best.setdefault(key, []).append((t, v))
    for (lon, lat), obs in best.items():
        obs.sort()
        newest = obs[-1][0]
        recent = [v for t, v in obs if (newest - t).days <= 2]
        sat.append([lon, lat, round(statistics.median(recent), 3), round((now - newest).total_seconds() / 86400, 1)])
    if len(sat) > 50:
        sat_meta = {"dataset": did, "title": title, "server": base, "cells": len(sat)}
        break
    sat = []
log["sat"] = sat_meta or "unavailable"
print("satellite cells:", len(sat), sat_meta)

# ------------------------------------------------------------------ forecast at sample points (Open-Meteo, free, no key)
points = []
B = 50
for i in range(0, len(PTS), B):
    chunk = PTS[i:i + B]
    lat = ",".join(str(p[1]) for p in chunk)
    lon = ",".join(str(p[0]) for p in chunk)
    m = get("https://marine-api.open-meteo.com/v1/marine", params={
        "latitude": lat, "longitude": lon, "hourly": "wave_height,wave_period,sea_surface_temperature",
        "forecast_days": 3, "timezone": "UTC", "cell_selection": "sea"})
    w = get("https://api.open-meteo.com/v1/forecast", params={
        "latitude": lat, "longitude": lon, "hourly": "wind_speed_10m,wind_direction_10m,precipitation",
        "past_days": 3, "forecast_days": 3, "wind_speed_unit": "kn", "timezone": "UTC"})
    mj = m.json() if m else []
    wj = w.json() if w else []
    mj = mj if isinstance(mj, list) else [mj]
    wj = wj if isinstance(wj, list) else [wj]
    for k, p in enumerate(chunk):
        rec = {"lon": p[0], "lat": p[1]}
        try:
            h = mj[k]["hourly"]
            t0 = h["time"][0]
            rec["t0"] = t0
            rec["wh"] = [h["wave_height"][j] for j in range(0, min(72, len(h["time"])), 3)]
            rec["wp"] = [h["wave_period"][j] for j in range(0, min(72, len(h["time"])), 3)]
            rec["sst"] = [h["sea_surface_temperature"][j] for j in range(0, min(72, len(h["time"])), 3)]
        except Exception:
            pass
        try:
            h = wj[k]["hourly"]
            times = h["time"]
            nowkey = now.strftime("%Y-%m-%dT%H:00")
            idx = times.index(nowkey) if nowkey in times else 72
            rain = [x or 0 for x in h["precipitation"][max(0, idx - 72):idx]]
            rec["rain72"] = round(sum(rain), 1)
            start = times.index(rec["t0"]) if rec.get("t0") in times else idx
            rec["ws"] = [h["wind_speed_10m"][j] for j in range(start, min(start + 72, len(times)), 3)]
            rec["wd"] = [h["wind_direction_10m"][j] for j in range(start, min(start + 72, len(times)), 3)]
            rec.setdefault("t0", times[start])
        except Exception:
            pass
        points.append(rec)
    time.sleep(1)
log["points_with_waves"] = sum(1 for p in points if p.get("wh"))
log["points_with_wind"] = sum(1 for p in points if p.get("ws"))
print("points:", len(points), log["points_with_waves"], log["points_with_wind"])

# ------------------------------------------------------------------ public diver reports (Google Sheet published as CSV)
reports = []
cfg = json.load(open(CFG_PATH)) if os.path.exists(CFG_PATH) else {}
if cfg.get("csv_url"):
    r = get(cfg["csv_url"])
    if r:
        rows = list(csv.DictReader(io.StringIO(r.content.decode("utf-8-sig"))))
        per_cell_hour = {}
        for row in rows:
            try:
                lat = round(float(row.get("lat", "")), 2)
                lon = round(float(row.get("lon", "")), 2)
                vis = float(row.get("visibility_ft", ""))
                when = dt.datetime.fromisoformat(row.get("observed_at", "").replace("Z", "+00:00"))
            except (ValueError, TypeError):
                continue
            if when.tzinfo is None:
                when = when.replace(tzinfo=dt.timezone.utc)
            age_h = (now - when).total_seconds() / 3600
            if not (1 <= vis <= 100) or not (32.4 <= lat <= 42.1 and -125.5 <= lon <= -117) or not (-1 <= age_h <= 7 * 24):
                continue
            if not near_coast(lon, lat, km=8):
                continue
            key = (lat, lon, when.strftime("%Y%m%d%H"))
            per_cell_hour[key] = per_cell_hour.get(key, 0) + 1
            if per_cell_hour[key] > 3:   # flood protection: max 3 reports per ~1 km cell per hour
                continue
            temp = None
            try:
                t = float(row.get("water_temp_f", ""))
                temp = t if 40 <= t <= 85 else None
            except (ValueError, TypeError):
                pass
            act = (row.get("activity") or "").strip().lower()
            act = act if act in ("dive", "snorkel", "surface") else ""
            reports.append({"lat": lat, "lon": lon, "vis": round(vis), "temp": temp, "act": act,
                            "t": when.isoformat(timespec="minutes")})
    log["reports"] = len(reports)
print("reports:", len(reports))

out = {"updated": now.isoformat(timespec="minutes"), "sat": sat, "sat_source": sat_meta, "points": points,
       "reports": reports, "log": log}
if not sat and not log["points_with_waves"]:
    print("No usable data this run; keeping previous file")
    sys.exit(0)
with open(OUT, "w") as fh:
    json.dump(out, fh, separators=(",", ":"))
print("wrote", OUT, os.path.getsize(OUT) // 1024, "KB")
