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


def ginfo(base, did):
    r = get(f"{base}/info/{did}/index.json")
    if not r:
        return None
    rows = r.json()["table"]["rows"]
    g = {r[2]: r[4] for r in rows if r[0] == "attribute" and r[1] == "NC_GLOBAL"}
    var = next((r[1] for r in rows if r[0] == "variable" and "kd" in r[1].lower()), None)
    dims = [r[1] for r in rows if r[0] == "dimension"]
    num = lambda k: float(re.findall(r"-?[\d.]+", g.get(k, "nan"))[0]) if re.findall(r"-?[\d.]+", g.get(k, "")) else None
    return {"var": var, "dims": dims, "latmin": num("geospatial_lat_min"), "latmax": num("geospatial_lat_max"),
            "lonmin": num("geospatial_lon_min"), "lonmax": num("geospatial_lon_max"),
            "res": num("geospatial_lat_resolution"), "end": g.get("time_coverage_end", "")}


def find_kd490():
    cands = []
    for base in ERDDAPS:
        for term in ("kd490", "kd_490", "Kd490 daily"):
            r = get(f"{base}/search/index.json", params={"page": 1, "itemsPerPage": 300, "searchFor": term})
            if not r:
                continue
            j = r.json()["table"]
            cols = j["columnNames"]
            for row in j["rows"]:
                d = dict(zip(cols, row))
                title, did = d.get("Title", ""), d.get("Dataset ID", "")
                t = title.lower()
                if not d.get("griddap") or "end of mission" in t or "climatolog" in t or "monthly" in t or "8-day" in t or "weekly" in t:
                    continue
                if not ("daily" in t or "1day" in did.lower()):
                    continue
                score = ("dineof" in t or "gap-fill" in t or "gap fill" in t) * 6 + ("near real" in t or "nrt" in t) * 3 \
                        + ("750" in t) * 2 + ("noaa-21" in t or "noaa21" in did.lower() or "n21" in did.lower()) * 1 \
                        + ("noaa-20" in t or "n20" in did.lower()) * 1 + ("science quality" in t) * -2
                if (score, base, did, title) not in cands:
                    cands.append((score, base, did, title))
    cands.sort(key=lambda c: -c[0])
    good = []
    for c in cands[:40]:
        info = ginfo(c[1], c[2])
        if not info or not info["var"]:
            continue
        lonmin, lonmax = info["lonmin"], info["lonmax"]
        if lonmin is None or info["latmin"] is None:
            continue
        lon360 = lonmax is not None and lonmax > 180
        lo1, lo2 = (-124 % 360, -118 % 360) if lon360 else (-124, -118)
        covers = info["latmin"] <= 33 and info["latmax"] >= 41 and lonmin <= lo1 and lonmax >= lo2
        try:
            age = (now - dt.datetime.fromisoformat(info["end"].replace("Z", "+00:00"))).days
        except Exception:
            age = 99
        if covers and age <= 5:
            good.append((c[0], c[1], c[2], c[3], info, lon360))
    log["kd490_candidates"] = [(g[2], g[3]) for g in good[:8]]
    return good


def fetch_kd490(base, did, info, lon360):
    var, dims = info["var"], info["dims"]
    res = info["res"] or 0.0125
    stride = max(1, round(0.02 / res))
    lonA, lonB = (-125.0 % 360, -117.0 % 360) if lon360 else (-125.0, -117.0)
    def q(lat_order):
        parts = []
        for d in dims:
            if d == "time":
                parts.append("[(last-4):1:(last)]")
            elif d == "latitude":
                parts.append(f"[({lat_order[0]}):{stride}:({lat_order[1]})]")
            elif d == "longitude":
                parts.append(f"[({lonA}):{stride}:({lonB})]")
            else:
                parts.append("[0]")
        return var + "".join(parts)
    for order in ((32.4, 42.1), (42.1, 32.4)):
        r = get(f"{base}/griddap/{did}.csv?{q(order)}")
        if r and len(r.text) > 1000:
            return var, r.text, lon360
    return None


sat, sat_meta = [], {}
for score, base, did, title, info, lon360 in find_kd490()[:5]:
    print("[kd490] trying", did, "|", title)
    got = fetch_kd490(base, did, info, lon360)
    if not got:
        continue
    var, text, lon360 = got
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
        if lon > 180:
            lon -= 360
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
    mp = {"latitude": lat, "longitude": lon, "hourly": "wave_height,wave_period,wave_direction,sea_surface_temperature",
          "past_days": 3, "forecast_days": 3, "timezone": "UTC", "cell_selection": "sea"}
    m = get("https://marine-api.open-meteo.com/v1/marine", params=mp)
    if not m:   # fall back to forecast only if the past-days request is refused
        mp.pop("past_days")
        m = get("https://marine-api.open-meteo.com/v1/marine", params=mp)
    w = get("https://api.open-meteo.com/v1/forecast", params={
        "latitude": lat, "longitude": lon, "hourly": "wind_speed_10m,wind_direction_10m,precipitation,cloud_cover",
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
            rng = range(0, len(h["time"]), 3)
            rec["wh"] = [h["wave_height"][j] for j in rng]
            rec["wp"] = [h["wave_period"][j] for j in rng]
            rec["wdir"] = [h["wave_direction"][j] for j in rng]
            rec["sst"] = [h["sea_surface_temperature"][j] for j in rng]
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
            rec["ws"] = [h["wind_speed_10m"][j] for j in range(start, min(start + 144, len(times)), 3)]
            rec["wd"] = [h["wind_direction_10m"][j] for j in range(start, min(start + 144, len(times)), 3)]
            rec["cc"] = [h["cloud_cover"][j] for j in range(start, min(start + 144, len(times)), 3)]
            rec.setdefault("t0", times[start])
        except Exception:
            pass
        points.append(rec)
    time.sleep(1)
log["points_with_waves"] = sum(1 for p in points if p.get("wh"))
log["points_with_wind"] = sum(1 for p in points if p.get("ws"))
print("points:", len(points), log["points_with_waves"], log["points_with_wind"])

# ------------------------------------------------------------------ public diver reports (Google Sheet published as CSV)
reports, bias_obs = [], {}
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
            if not (1 <= vis <= 100) or not (32.4 <= lat <= 42.1 and -125.5 <= lon <= -117) or not (-1 <= age_h <= 180 * 24):
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
            try:   # the app's own estimate at the time, so we can learn how each spot differs from it
                mft = float(row.get("model_ft", ""))
                if 2 <= mft <= 100:
                    bias_obs.setdefault((round(lon / 0.02) * 0.02, round(lat / 0.02) * 0.02), []).append(vis / mft)
            except (ValueError, TypeError):
                pass
            if age_h <= 7 * 24:
                reports.append({"lat": lat, "lon": lon, "vis": round(vis), "temp": temp, "act": act,
                                "t": when.isoformat(timespec="minutes")})
    log["reports"] = len(reports)
print("reports:", len(reports))

bias = []
for (blon, blat), ratios in bias_obs.items():
    r = max(0.5, min(2.0, statistics.median(ratios)))
    n = len(ratios)
    bias.append([round(blon, 2), round(blat, 2), round(math.exp(math.log(r) * n / (n + 3)), 2), n])

out = {"updated": now.isoformat(timespec="minutes"), "sat": sat, "sat_source": sat_meta, "points": points,
       "reports": reports, "bias": bias, "log": log}
if not sat and not log["points_with_waves"]:
    print("No usable data this run; keeping previous file")
    sys.exit(0)
with open(OUT, "w") as fh:
    json.dump(out, fh, separators=(",", ":"))
print("wrote", OUT, os.path.getsize(OUT) // 1024, "KB")
