#!/usr/bin/env python3
"""Download the public CDFW data LineCheck is built from.

Runs in GitHub Actions (which has open internet). Writes:
  data/gis/<name>.geojson   CDFW GIS layers (MPAs, groundfish lines and areas)
  data/gis/_report.json     what was found, field names, feature counts
  raw/pages/<slug>.html     raw CDFW / regulation pages, for authoring and change detection
  raw/manifest.json         url, fetch time, and sha256 of each raw page
"""
import hashlib, json, os, re, sys, time, datetime
from urllib.parse import urljoin
import requests

S = requests.Session()
S.headers["User-Agent"] = "LineCheck data fetch (https://github.com/erikloken87/linecheck)"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GIS = os.path.join(ROOT, "data", "gis")
RAW = os.path.join(ROOT, "raw", "pages")
os.makedirs(GIS, exist_ok=True)
os.makedirs(RAW, exist_ok=True)

DATASETS = {
    "mpa": "ds582",            # California Marine Protected Areas
    "rca": "ds3144",           # Rockfish Conservation Area lines
    "gf_areas": "ds3143",      # Groundfish recreational management area boundaries
    "gf_exclusion": "ds3164",  # Groundfish exclusion areas (southern CA)
}

PAGES = {
    "ocean-index": "https://wildlife.ca.gov/Fishing/Ocean",
    "groundfish-summary": "https://wildlife.ca.gov/Fishing/Ocean/Regulations/Groundfish-Summary",
    "inseason": "https://wildlife.ca.gov/Fishing/Ocean/Regulations/Inseason",
    "ccr-632": "https://www.law.cornell.edu/regulations/california/14-CCR-632",
    "mpa-network": "https://wildlife.ca.gov/Conservation/Marine/MPAs/Network",
}
EXTRA_LINK_PATTERNS = [r"/Fishing/Ocean/Regulations/Fishing-Map/[\w-]+", r"/Fishing/Ocean/Regulations/[\w-]+$",
                       r"/Conservation/Marine/MPAs/Network/[\w-]+-California$"]

report = {"fetched_at": datetime.datetime.utcnow().isoformat() + "Z", "datasets": {}, "pages": {}}


def get(url, **kw):
    for attempt in range(4):
        try:
            r = S.get(url, timeout=90, **kw)
            if r.status_code == 200:
                return r
            print(f"  {r.status_code} {url}")
        except Exception as e:
            print(f"  error {e} {url}")
        time.sleep(3 * (attempt + 1))
    return None


def find_service(code):
    """Search ArcGIS Online for the CDFW feature service with [code] in its title."""
    for q in (f'title:"{code}" type:"Feature Service"', f'{code} CDFW'):
        r = get("https://www.arcgis.com/sharing/rest/search", params={"q": q, "f": "json", "num": 50})
        if not r:
            continue
        items = r.json().get("results", [])
        hits = [i for i in items if f"[{code}]" in (i.get("title") or "") and i.get("url")]
        # Prefer CDFW's own BIOS org, then newest
        hits.sort(key=lambda i: ("Uq9r85Potqm3MfRV" not in i.get("url", ""), "Feature Service" != i.get("type"), -i.get("modified", 0)))
        if hits:
            return hits[0], [(i["title"], i.get("type"), i.get("url")) for i in hits[:8]]
    return None, []


def query_layer(url):
    url = url.rstrip("/")
    if re.search(r"/\d+$", url):
        layer = url
    else:
        meta = get(url, params={"f": "json"}).json()
        layers = meta.get("layers") or []
        layer = f"{url}/{layers[0]['id'] if layers else 0}"
    lmeta = get(layer, params={"f": "json"}).json()
    fields = [f["name"] for f in lmeta.get("fields", [])]
    feats, off = [], 0
    while True:
        r = get(layer + "/query", params={"where": "1=1", "outFields": "*", "outSR": 4326, "f": "geojson",
                                          "resultOffset": off, "resultRecordCount": 1000, "geometryPrecision": 6})
        j = r.json() if r else {}
        fs = j.get("features", [])
        feats += fs
        more = j.get("exceededTransferLimit") or (j.get("properties") or {}).get("exceededTransferLimit")
        if not fs or not more:
            break
        off += len(fs)
    return layer, lmeta.get("name"), fields, feats


for name, code in DATASETS.items():
    print(f"[{name}] {code}")
    item, cands = find_service(code)
    entry = {"code": code, "candidates": cands}
    if not item:
        entry["error"] = "not found"
        report["datasets"][name] = entry
        continue
    try:
        layer, lname, fields, feats = query_layer(item["url"])
        entry.update(title=item["title"], item_id=item["id"], layer=layer, layer_name=lname, fields=fields,
                     count=len(feats), modified=item.get("modified"),
                     sample=[f.get("properties") for f in feats[:3]])
        with open(os.path.join(GIS, f"{name}.geojson"), "w") as fh:
            json.dump({"type": "FeatureCollection", "features": feats}, fh, separators=(",", ":"))
        print(f"  {len(feats)} features from {layer}")
    except Exception as e:
        entry["error"] = repr(e)
        print("  failed", e)
    report["datasets"][name] = entry


# Raw pages
manifest_path = os.path.join(ROOT, "raw", "manifest.json")
manifest = {}
links = set()
def slug(url):
    s = re.sub(r"^https?://(www\.)?", "", url).strip("/")
    return re.sub(r"[^\w-]+", "_", s)[:120]

def save_page(key, url):
    r = get(url)
    if not r:
        report["pages"][key] = {"url": url, "error": "fetch failed"}
        return None
    html = r.text
    fn = f"{key}.html"
    with open(os.path.join(RAW, fn), "w") as fh:
        fh.write(html)
    manifest[key] = {"url": url, "file": f"raw/pages/{fn}", "sha256": hashlib.sha256(html.encode()).hexdigest(),
                     "fetched_at": report["fetched_at"]}
    report["pages"][key] = {"url": url, "bytes": len(html)}
    return html

for key, url in PAGES.items():
    html = save_page(key, url)
    if html:
        for m in re.finditer(r'href="([^"#?]+)"', html):
            href = urljoin(url, m.group(1))
            if "wildlife.ca.gov" in href and any(re.search(p, href, re.I) for p in EXTRA_LINK_PATTERNS):
                links.add(href)

for url in sorted(links):
    key = slug(url).replace("wildlife_ca_gov_", "")
    if key not in manifest:
        save_page(key, url)
        time.sleep(0.5)

# Optional photo list authored by hand: data/photo_sources.json -> [{"id":..., "page": url}]
ps = os.path.join(ROOT, "data", "photo_sources.json")
if os.path.exists(ps):
    for p in json.load(open(ps)):
        if not p.get("page"):
            continue
        html = save_page("photo_" + p["id"], p["page"])
        if not html:
            continue
        m = re.search(r'<meta[^>]+property="og:image"[^>]+content="([^"]+)"', html) or \
            re.search(r'<meta[^>]+content="([^"]+)"[^>]+property="og:image"', html)
        if m:
            img = get(urljoin(p["page"], m.group(1)))
            if img and img.headers.get("content-type", "").startswith("image"):
                os.makedirs(os.path.join(ROOT, "raw", "photos"), exist_ok=True)
                with open(os.path.join(ROOT, "raw", "photos", p["id"] + ".img"), "wb") as fh:
                    fh.write(img.content)
                report["pages"]["photo_" + p["id"]]["image"] = m.group(1)

# Public-domain photos from Wikimedia Commons (US federal works only) for species without a NOAA page photo
FED = re.compile(r"NOAA|NMFS|National Oceanic|National Marine Fisheries|National Marine Sanctuar|National Park Service|NPS|Fish and Wildlife Service|USFWS|USGS|Geological Survey", re.I)
credits_path = os.path.join(ROOT, "raw", "photos", "commons.json")
os.makedirs(os.path.dirname(credits_path), exist_ok=True)
commons = {}
sp_path = os.path.join(ROOT, "data", "manual", "species.json")
if os.path.exists(sp_path):
    for sp in json.load(open(sp_path))["species"]:
        sci = sp["sci"].split("/")[0].strip()
        r = get("https://commons.wikimedia.org/w/api.php", params={
            "action": "query", "generator": "search", "gsrsearch": f'"{sci}" filetype:bitmap', "gsrnamespace": 6, "gsrlimit": 25,
            "prop": "imageinfo", "iiprop": "url|extmetadata|size", "iiurlwidth": 900, "format": "json"})
        if not r:
            continue
        pages = sorted((r.json().get("query") or {}).get("pages", {}).values(), key=lambda p: p.get("index", 99))
        for pg in pages:
            ii = (pg.get("imageinfo") or [{}])[0]
            md = ii.get("extmetadata") or {}
            lic = (md.get("LicenseShortName") or {}).get("value", "")
            who = " ".join(re.sub("<[^>]+>", " ", (md.get(k) or {}).get("value", "")) for k in ("Artist", "Credit", "UsageTerms", "ImageDescription"))
            if "public domain" not in lic.lower() or not FED.search(who) or ii.get("width", 0) < 400:
                continue
            img = get(ii.get("thumburl") or ii["url"])
            if not img:
                continue
            with open(os.path.join(ROOT, "raw", "photos", f"c_{sp['id']}.img"), "wb") as fh:
                fh.write(img.content)
            artist = clean_html = re.sub(r"\s+", " ", re.sub("<[^>]+>", " ", (md.get("Artist") or {}).get("value", ""))).strip()
            commons[sp["id"]] = {"title": pg["title"], "page": ii.get("descriptionurl"), "artist": artist[:120], "license": lic,
                                 "credit": re.sub(r"\s+", " ", re.sub("<[^>]+>", " ", (md.get("Credit") or {}).get("value", ""))).strip()[:160]}
            break
        time.sleep(0.3)
    with open(credits_path, "w") as fh:
        json.dump(commons, fh, indent=1)
    print("commons photos:", len(commons))

with open(manifest_path, "w") as fh:
    json.dump(manifest, fh, indent=1, sort_keys=True)
with open(os.path.join(GIS, "_report.json"), "w") as fh:
    json.dump(report, fh, indent=1)
print("done:", {k: v.get("count") for k, v in report["datasets"].items()}, len(manifest), "pages")
