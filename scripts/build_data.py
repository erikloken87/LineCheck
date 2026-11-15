#!/usr/bin/env python3
"""Turn the raw CDFW downloads (data/gis, raw/pages) into the compact files the app loads (data/app).

Run after fetch_data.py. Deterministic, so the weekly GitHub Action can rebuild without a human,
and the hand-written files in data/manual are copied through unchanged.
"""
import json, os, re, datetime, shutil
from bs4 import BeautifulSoup
from shapely.geometry import shape, mapping

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GIS = os.path.join(ROOT, "data", "gis")
RAW = os.path.join(ROOT, "raw", "pages")
OUT = os.path.join(ROOT, "data", "app")
MAN = os.path.join(ROOT, "data", "manual")
os.makedirs(OUT, exist_ok=True)


def load(p):
    with open(p) as fh:
        return json.load(fh)


def dump(name, obj):
    with open(os.path.join(OUT, name), "w") as fh:
        json.dump(obj, fh, separators=(",", ":"), ensure_ascii=False)


def rnd(geom, nd=5):
    def r(c):
        if isinstance(c[0], (float, int)):
            return [round(c[0], nd), round(c[1], nd)]
        return [r(x) for x in c]
    return {"type": geom["type"], "coordinates": r(geom["coordinates"])}


def simplify(geom, tol):
    g = shape(geom)
    if not g.is_valid:
        g = g.buffer(0)
    s = g.simplify(tol, preserve_topology=True)
    return rnd(mapping(s))


def norm(s):
    return re.sub(r"[^a-z]", "", (s or "").lower().replace("ñ", "n"))


def clean(s):
    return re.sub(r"\s+", " ", s or "").strip()


report = load(os.path.join(GIS, "_report.json"))
meta = {"built_at": datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None).replace(microsecond=0).isoformat() + "Z",
        "gis_fetched_at": report.get("fetched_at"), "sources": {}}

# ---------------------------------------------------------------- MPA regulations (14 CCR 632)
ccr_html = open(os.path.join(RAW, "ccr-632.html")).read()
ccr = clean(BeautifulSoup(ccr_html, "html.parser").get_text(" "))
TYPE_RE = r"(State Marine Reserve|State Marine Conservation Area(?: \(No-Take\))?|State Marine Park|State Marine Recreational Management Area|Special Closure)"
entries = list(re.finditer(r"\((\d{1,3})\) ([A-Z][A-Za-z0-9'’.ñ/()\- ]{2,90}? " + TYPE_RE + r")\.?(?= \(A\)| Special restrictions)", ccr))
ccr_by_name = {}
for i, m in enumerate(entries):
    body = ccr[m.end(): entries[i + 1].start() if i + 1 < len(entries) else len(ccr)]
    body = body.split("(c) ")[0] if i + 1 == len(entries) else body
    name = m.group(2)
    b = body.find("(B) ")
    restr = body[b + 4:].strip() if b >= 0 else ""
    restr = re.sub(r"\s*\(\d+\)\s*$", "", restr)
    sc = re.search(r"(Special closure restrictions.*?|[^.]*unlawful to enter.*?\.)(?= \([C-Z]\) |$)", body)
    ex = re.search(r"(?:specified exceptions?|specified activities are allowed[^:]*):? (.*?)(?= \([C-Z]\) |$)", restr)
    ccr_by_name[norm(name)] = {
        "name": name, "restriction": restr, "exceptions": ex.group(1).strip() if ex else "",
        "general": (re.search(r"632 \(a\)\(1\)\(([A-D])\)", restr) or [None, None])[1],
        "closure": (re.split(r"(?<=\.) ", restr)[0] if "Special Closure" in name else ""),
    }


def plain_rule(typ, fullname, c):
    """Short, plain-language summary of what's allowed. The full legal text is shown underneath."""
    no_take = "no-take" in (fullname + typ).lower() or typ == "SMR"
    if typ == "SMR":
        return "red", "No take of any kind", "Fishing and collecting are prohibited."
    if typ == "Special Closure" or typ == "FMCA":
        return "violet", "Special closure", c.get("closure") or "Entry and access restrictions apply."
    if no_take:
        return "red", "No take", "No fishing or collecting (no-take conservation area)."
    exc = c.get("exceptions") if c else ""
    rec = "recreational" in exc.lower()
    if typ == "SMCA":
        if not exc:
            return "red", "No take", "Take is prohibited unless specifically allowed."
        if not rec:
            return "red", "No recreational fishing", "Only commercial exceptions apply: " + exc
        exc2 = re.sub(r"^the ", "", exc.strip())
        return "amber", "Limited take", "Allowed: " + exc2[:1].upper() + exc2[1:]
    if typ == "SMP":
        return "amber", "No commercial take", ("Recreational exceptions: " + exc) if exc else "Commercial take prohibited; check recreational rules."
    if typ in ("SMRMA", "SMCA/SMRMA"):
        return "amber", "Recreational management area", ("Allowed: " + exc) if exc else "Recreational take allowed with restrictions."
    return "amber", typ, exc


mpa_src = load(os.path.join(GIS, "mpa.geojson"))
mpas, unmatched = [], []
for f in mpa_src["features"]:
    p = f["properties"]
    full = p.get("FULLNAME") or p.get("NAME")
    typ = (p.get("Type") or "").strip()
    key = norm(full)
    c = ccr_by_name.get(key)
    if not c:
        # loose match on short name + type words
        cands = [v for k, v in ccr_by_name.items() if norm(p.get("SHORTNAME")) in k]
        c = cands[0] if len(cands) == 1 else None
    if typ in ("FMR", "FMCA"):
        if "Reserve" in full:
            color, headline, summary = "red", "No take of any kind", "Federal marine reserve: fishing and collecting are prohibited."
        else:
            color, headline, summary = "amber", "Limited take", "Federal conservation area: only recreational fishing for lobster and pelagic finfish is allowed (50 CFR 922.73)."
    else:
        if not c:
            unmatched.append(full)
        color, headline, summary = plain_rule(typ, full or "", c or {})
    mpas.append({"type": "Feature", "geometry": simplify(f["geometry"], 0.00004),
                 "properties": {"name": p.get("NAME"), "full": full, "type": typ, "color": color,
                                "headline": headline, "summary": summary,
                                "legal": (c or {}).get("restriction", ""), "ccr": p.get("CCR")}})
dump("mpa.json", {"type": "FeatureCollection", "features": mpas})
meta["sources"]["mpa"] = {"title": report["datasets"]["mpa"].get("title"), "count": len(mpas),
                          "unmatched_regs": unmatched, "layer": report["datasets"]["mpa"].get("layer")}

# ---------------------------------------------------------------- Groundfish depth lines
rca = load(os.path.join(GIS, "rca.geojson"))
lines = {}
for f in rca["features"]:
    fm = str(int(f["properties"]["START_Fath"]))
    g = f["geometry"]
    parts = [g["coordinates"]] if g["type"] == "LineString" else g["coordinates"]
    for part in parts:
        lines.setdefault(fm, []).append([[round(x, 5), round(y, 5)] for x, y in part])
dump("lines.json", lines)

excl = load(os.path.join(GIS, "gf_exclusion.geojson"))
dump("exclusion.json", {"type": "FeatureCollection", "features": [
    {"type": "Feature", "geometry": rnd(f["geometry"]), "properties": {"name": f["properties"]["AreaName"]}}
    for f in excl["features"]]})

areas = load(os.path.join(GIS, "gf_areas.geojson"))
sfbay = [f for f in areas["features"] if f["properties"]["Region"] == "SF Bay"]
dump("sfbay.json", simplify(sfbay[0]["geometry"], 0.002) if sfbay else None)

# ---------------------------------------------------------------- Regional regulations
REGIONS = [  # key, CDFW page, name, south lat, north lat
    ("northern", "Northern", "Oregon border to Cape Mendocino (40°10′)", 40 + 10 / 60, 42.0),
    ("mendocino", "Mendocino", "Cape Mendocino to Point Arena", 38 + 57.5 / 60, 40 + 10 / 60),
    ("sanfrancisco", "San-Francisco", "Point Arena to Pigeon Point", 37 + 11 / 60, 38 + 57.5 / 60),
    ("central", "Central", "Pigeon Point to Point Conception", 34 + 27 / 60, 37 + 11 / 60),
    ("southern", "Southern", "Point Conception to the Mexico border", 32.5, 34 + 27 / 60),
    ("sfbay", "SF-Bay", "San Francisco Bay", None, None),
]


def section_cards(main, base_url):
    cards = []
    status_by_id = {}
    for img in main.find_all("img", src=re.compile(r"circle\.png", re.I)):
        a = img.find_next_sibling("a")
        if a and a.get("href", "").startswith("#"):
            src = img["src"].lower()
            status_by_id[a["href"][1:]] = "partial" if "yellow" in src else "closed" if "red" in src else "open"
    current = None
    for h in main.find_all(["h2", "h3"]):
        txt = clean(h.get_text())
        if h.name == "h2":
            current = "open" if "Open Fishing" in txt else "closed" if "Closed Fishing" in txt else None
            continue
        if not current or not h.get("id"):
            continue
        paras = []
        for sib in h.find_next_siblings():
            if sib.name in ("h2", "h3"):
                break
            for a in sib.find_all("a"):
                a.replace_with(a.get_text())
            t = clean(sib.get_text(" "))
            t = re.sub(r"\s+([,.;:)])", r"\1", t).replace("( ", "(").replace("(opens in new tab)", "").replace(" (PDF)", "")
            if t:
                paras.append(clean(t))
        body = " \n".join(paras)
        bag = re.search(r"(?:daily )?bag(?: and (?:total )?possession)? limit (?:is|for [^.]*? is) ([^.;]+)", body, re.I)
        size = re.search(r"minimum size limit (?:is|of) ([^.;,]+)", body, re.I) or re.search(r"no minimum size limit", body, re.I)
        cards.append({"id": h["id"], "title": txt, "status": status_by_id.get(h["id"], current if current == "closed" else "open"),
                      "season": current, "bag": re.split(r",? (?:with (?:a|no) minimum|and the minimum|and a minimum)", clean(bag.group(1)))[0].rstrip(", ") if bag else "",
                      "size": (clean(size.group(1)) if size and size.groups() else ("none" if size else "")),
                      "text": paras, "url": f"{base_url}#{h['id']}"})
    return cards


regions = []
for key, page, label, south, north in REGIONS:
    fn = os.path.join(RAW, f"Fishing_Ocean_Regulations_Fishing-Map_{page}.html")
    if not os.path.exists(fn):
        continue
    main = BeautifulSoup(open(fn).read(), "html.parser").find("main")
    url = f"https://wildlife.ca.gov/Fishing/Ocean/Regulations/Fishing-Map/{page}"
    full = clean(main.get_text(" "))
    upd = re.search(r"updated on ([A-Z][a-z]+ \d{1,2}, \d{4})", full)
    notes = []
    for p in main.find_all("p"):
        t = clean(p.get_text(" "))
        if t.startswith("NOTE"):
            notes.append(re.sub(r"\s+([,.;:)])", r"\1", t))
        if "Open Fishing Seasons" in t:
            break
    regions.append({"key": key, "name": page.replace("-", " ").replace("SF Bay", "SF Bay"), "label": label,
                    "south": south, "north": north, "updated": upd.group(1) if upd else None, "url": url,
                    "notes": list(dict.fromkeys(notes))[:3], "cards": section_cards(main, url)})
# Guard: if CDFW redesigns its pages and parsing breaks, fail loudly instead of publishing empty rules.
thin = [r["key"] for r in regions if len(r["cards"]) < 10]
if len(regions) < 6 or thin:
    raise SystemExit(f"Regulation parsing looks broken (regions={len(regions)}, thin={thin}); not publishing.")
dump("regs.json", regions)
meta["sources"]["regs"] = {r["key"]: r["updated"] for r in regions}

gf_txt = clean(BeautifulSoup(open(os.path.join(RAW, "groundfish-summary.html")).read(), "html.parser").get_text(" "))
gu = re.search(r"Updated ([A-Z][a-z]+ \d{1,2}, \d{4})", gf_txt)
meta["sources"]["groundfish_page_updated"] = gu.group(1) if gu else None

# ---------------------------------------------------------------- Hand-written files
for fn in os.listdir(MAN) if os.path.isdir(MAN) else []:
    if fn.endswith(".json"):
        shutil.copy(os.path.join(MAN, fn), os.path.join(OUT, fn))
man_gf = os.path.join(MAN, "groundfish.json")
if os.path.exists(man_gf):
    meta["sources"]["groundfish_rules_checked"] = load(man_gf).get("checked")
    meta["sources"]["groundfish_rules_source_date"] = load(man_gf).get("source_updated")

# ---------------------------------------------------------------- Species photos (US federal / public domain only)
sp_out = os.path.join(OUT, "species.json")
if os.path.exists(sp_out):
    try:
        from PIL import Image
        Image.MAX_IMAGE_PIXELS = 40_000_000  # refuse absurdly large (decompression-bomb) images
    except ImportError:
        Image = None
    FED = re.compile(r"NOAA|NMFS|National Marine Sanctuar|National Park Service|Fish and Wildlife Service|USGS", re.I)
    pdir = os.path.join(ROOT, "raw", "photos")
    photos_dir = os.path.join(ROOT, "photos")
    os.makedirs(photos_dir, exist_ok=True)
    COMMONS_REJECTED = set(load(os.path.join(MAN, "photo_review.json")).get("rejected", [])) if os.path.exists(os.path.join(MAN, "photo_review.json")) else set()
    commons = load(os.path.join(pdir, "commons.json")) if os.path.exists(os.path.join(pdir, "commons.json")) else {}
    spj = load(sp_out)
    used = 0
    for sp in spj["species"]:
        src, credit = None, None
        noaa_img, noaa_page = os.path.join(pdir, sp["id"] + ".img"), os.path.join(RAW, f"photo_{sp['id']}.html")
        if os.path.exists(noaa_img) and os.path.exists(noaa_page):
            t = clean(BeautifulSoup(open(noaa_page).read(), "html.parser").get_text(" "))
            m = re.search(r"Credit: (.{0,90}?)(?= [A-Z][a-z]+ [a-z]|$)", t)
            if m and FED.search(m.group(1)):
                cr = re.split(r"\.| Credit|\s(?=" + re.escape(sp["name"].split()[0]) + ")", m.group(1))[0].strip()
                src, credit = noaa_img, cr if cr.startswith("NOAA") else cr + ", via NOAA Fisheries"
        # Commons picks reviewed by eye; these were wrong species or unclear credit
        if not src and sp["id"] not in COMMONS_REJECTED and sp["id"] in commons and os.path.exists(os.path.join(pdir, f"c_{sp['id']}.img")):
            c = commons[sp["id"]]
            who = c.get("credit") if (not c.get("artist") or c["artist"].startswith("User ") or "Unknown" in c["artist"]) else c["artist"]
            src, credit = os.path.join(pdir, f"c_{sp['id']}.img"), f"{who.rstrip('.')}, public domain (Wikimedia Commons)"
        if src and Image:
            try:
                im = Image.open(src).convert("RGB")
                im.thumbnail((900, 900))
                im.save(os.path.join(photos_dir, sp["id"] + ".jpg"), quality=78, optimize=True)
                sp["photo"], sp["photo_credit"] = f"photos/{sp['id']}.jpg", credit
                used += 1
            except Exception as e:
                print("photo failed", sp["id"], e)
    dump("species.json", spj)
    meta["sources"]["photos"] = used

dump("meta.json", meta)
print(json.dumps({k: (v if k != "mpa" else {kk: vv for kk, vv in v.items() if kk != "unmatched_regs"}) for k, v in meta["sources"].items()}, indent=1))
print("unmatched MPA regs:", unmatched)
