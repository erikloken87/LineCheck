#!/usr/bin/env python3
"""Experiment 2: structure of CDIP's combined alongshore wave files. Writes raw/mop_probe.json."""
import json, re, os, requests
S = requests.Session(); S.headers["User-Agent"] = "LineCheck experiment (https://github.com/erikloken87/linecheck)"
B = "https://thredds.cdip.ucsd.edu/thredds"
out = {"errors": []}
def get(u):
    try:
        r = S.get(u, timeout=120)
        return r if r.status_code == 200 else out["errors"].append(f"{r.status_code} {u[-110:]}") or None
    except Exception as e:
        out["errors"].append(f"{e!r} {u[-110:]}"); return None
r = get(B + "/catalog/cdip/model/MOP_alongshore/catalog.xml")
names = sorted(set(re.findall(r'name="([^"/]+\.nc)"', r.text)))
agg = [n for n in names if "alongshore" in n]
out["agg"] = agg
D = B + "/dodsC/cdip/model/MOP_alongshore/"
for n in agg:
    d = get(D + n + ".dds"); out[n + ".dds"] = d.text[:2500] if d else None
for n in [a for a in agg if "nowcast" in a or a.endswith("alongshore_forecast.nc")]:
    d = get(D + n + ".dds")
    if not d: continue
    dims = dict(re.findall(r"(\w+) = (\d+)\]", d.text))
    out[n + ".dims"] = dims
    das = get(D + n + ".das"); out[n + ".das"] = das.text[:1800] if das else None
    tN = int(dims.get("waveTime", 1))
    for q in (f"waveTime[{tN-2}:1:{tN-1}]", "metaLatitude[0:400:2000]", "metaLongitude[0:400:2000]", "metaSiteLabel[0:400:2000]", f"waveHs[{tN-1}][0:400:2000]", f"waveHs[0:400:2000][{tN-1}]"):
        a = get(D + n + ".ascii?" + q); out[n + " " + q] = a.text[-500:] if a else None
os.makedirs("raw", exist_ok=True)
json.dump(out, open("raw/mop_probe.json", "w"), indent=1)
print(json.dumps(out, indent=1)[:9000])
