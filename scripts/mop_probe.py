#!/usr/bin/env python3
"""Experiment: can we read Scripps CDIP's nearshore wave model (MOP) for the SLO coast? Writes raw/mop_probe.json."""
import json, re, time, collections, os, math
import requests
S = requests.Session(); S.headers["User-Agent"] = "LineCheck experiment (https://github.com/erikloken87/linecheck)"
B = "https://thredds.cdip.ucsd.edu/thredds"
out = {"errors": []}
def get(u):
    try:
        r = S.get(u, timeout=90)
        return r if r.status_code == 200 else out["errors"].append(f"{r.status_code} {u[-90:]}") or None
    except Exception as e:
        out["errors"].append(f"{e!r} {u[-90:]}"); return None
r = get(B + "/catalog/cdip/model/MOP_alongshore/catalog.xml")
names = sorted(set(re.findall(r'name="([^"/]+\.nc)"', r.text))) if r else []
out["files"] = len(names); out["sample"] = names[:12]
out["kinds"] = collections.Counter(re.sub(r"^[A-Z]+\d+_", "", n) for n in names).most_common(8)
out["prefixes"] = collections.Counter((re.match(r"[A-Z]+", n) or [None])[0] for n in names).most_common(30)
sl = [n for n in names if n.startswith("SL") and "nowcast" in n]
out["sl_nowcast"] = len(sl)
def num(txt, var):
    data = txt.split("-----")[-1] if "-----" in txt else txt
    m = re.search(var.replace(r"\[", "") + r"(?:\[\d+\])?\s*[,\n]\s*([-\d.eE+, \n]*)", data)
    if not m:
        return None
    vals = re.findall(r"-?\d+\.?\d*(?:[eE][-+]?\d+)?", m.group(1).split("\n\n")[0])
    return [float(v) for v in vals] or None
if sl:
    D = B + "/dodsC/cdip/model/MOP_alongshore/"
    dds = get(D + sl[0] + ".dds"); out["dds"] = dds.text[:1500] if dds else None
    pts = []
    for n in sl[::12]:
        a = get(D + n + ".ascii?metaLatitude,metaLongitude")
        if a and "raw_latlon" not in out: out["raw_latlon"] = a.text[:500]
        if a:
            la, lo = num(a.text, "metaLatitude"), num(a.text, "metaLongitude")
            if la and lo: pts.append((n, la[0], lo[0]))
        time.sleep(0.15)
    out["sampled_points"] = len(pts); out["lat_range"] = [min(p[1] for p in pts), max(p[1] for p in pts)] if pts else None
    targets = {"Avila Pier": (35.172, -120.735), "Port San Luis harbor": (35.170, -120.752), "Pismo Beach": (35.137, -120.648), "Pecho Rock": (35.176, -120.82), "Montana de Oro": (35.27, -120.90)}
    res = {}
    for name, (tla, tlo) in targets.items():
        if not pts: break
        n, la, lo = min(pts, key=lambda p: math.hypot((p[1] - tla) * 111, (p[2] - tlo) * 91))
        rec = {"file": n, "lat": la, "lon": lo, "km_away": round(math.hypot((la - tla) * 111, (lo - tlo) * 91), 1)}
        d = get(D + n + ".dds"); m = re.search(r"waveTime = (\d+)", d.text) if d else None
        if m:
            N = int(m.group(1)); q = f"[{N-3}:1:{N-1}]"
            a = get(D + n + f".ascii?waveTime{q},waveHs{q},waveTp{q},waveDp{q}")
            if a:
                for v in ("waveTime", "waveHs", "waveTp", "waveDp"): rec[v] = num(a.text, v + r"\[")
                rec["raw"] = a.text[:400]
        f = get(D + n.replace("nowcast", "forecast") + ".dds"); m = re.search(r"waveTime = (\d+)", f.text) if f else None
        rec["forecast_steps"] = int(m.group(1)) if m else None
        res[name] = rec
    out["targets"] = res
os.makedirs("raw", exist_ok=True)
json.dump(out, open("raw/mop_probe.json", "w"), indent=1)
print(json.dumps(out, indent=1)[:6000])
