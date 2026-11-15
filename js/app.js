/* LineCheck — am I inside an MPA or a groundfish closure right now? */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const D = {};
// Only allow links/images we expect; anything else from the data files is dropped.
const safeUrl = u => /^https:\/\/(www\.)?wildlife\.ca\.gov\//.test(u || "") ? esc(u) : "#";
const safePhoto = u => /^photos\/[a-z0-9_-]+\.jpg$/.test(u || "") ? u : "";
const state = { gps: null, pin: null, lastKey: null, follow: true, region: null, regionPinned: false };
const PINNED = ["rockfish", "lingcod", "cabezon", "greenlings", "halibut", "dungeness", "rock", "surfperch"];
const STALE_DAYS = 30;

async function loadData() {
  const files = ["mpa", "lines", "exclusion", "regs", "groundfish", "meta", "coast", "sfbay", "species"];
  await Promise.all(files.map(async f => {
    try { D[f] = await (await fetch(`data/app/${f}.json`)).json(); } catch (e) { D[f] = null; console.warn("missing", f); }
  }));
  for (const f of D.mpa.features) { f.bbox = Geo.bbox(f.geometry); f.rings = Geo.geomRings(f.geometry); }
  for (const f of D.exclusion?.features || []) f.rings = Geo.geomRings(f.geometry);
}

/* ------------------------------------------------------------------ evaluation */
function todayMMDD(d = new Date()) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", month: "2-digit", day: "2-digit", year: "numeric" }).formatToParts(d);
  const g = t => p.find(x => x.type === t).value;
  return { md: `${g("month")}-${g("day")}`, ymd: `${g("year")}-${g("month")}-${g("day")}` };
}

function evaluate(lat, lon, acc) {
  const tol = Math.max(acc || 0, 10);
  const inside = [], near = [];
  let nearest = null;
  for (const f of D.mpa.features) {
    const b = f.bbox;
    if (lon < b[0] - 0.3 || lon > b[2] + 0.3 || lat < b[1] - 0.3 || lat > b[3] + 0.3) continue;
    const e = Geo.edgeDist(f.rings, lon, lat);
    if (Geo.contains(f.geometry, lon, lat)) inside.push({ f, e });
    else {
      if (e.d <= tol) near.push({ f, e });
      if (!nearest || e.d < nearest.e.d) nearest = { f, e };
    }
  }
  if (!nearest) { // far from everything: widen search
    for (const f of D.mpa.features) {
      const cx = (f.bbox[0] + f.bbox[2]) / 2, cy = (f.bbox[1] + f.bbox[3]) / 2;
      const dd = Math.hypot((cx - lon) * Math.cos(lat * Math.PI / 180), cy - lat);
      if (!nearest || dd < nearest.dd) nearest = { f, dd };
    }
    if (nearest) nearest.e = Geo.edgeDist(nearest.f.rings, lon, lat);
  }
  // strictest first: red > violet > amber
  const rank = c => ({ red: 0, violet: 1, amber: 2 }[c] ?? 3);
  inside.sort((a, b) => rank(a.f.properties.color) - rank(b.f.properties.color));
  near.sort((a, b) => rank(a.f.properties.color) - rank(b.f.properties.color));

  const gf = groundfishAt(lat, lon, tol);
  const excl = (D.exclusion?.features || []).filter(f => Geo.contains(f.geometry, lon, lat));
  return { lat, lon, acc, inside, near, nearest, gf, excl, region: regionAt(lat, lon) };
}

function regionAt(lat, lon) {
  if (D.sfbay && Geo.contains(D.sfbay, lon, lat)) return "sfbay";
  const r = (D.regs || []).find(r => r.south != null && lat >= r.south && lat < r.north);
  return r ? r.key : (lat >= 42 ? "northern" : "southern");
}

function groundfishAt(lat, lon, tol) {
  const G = D.groundfish;
  if (!G) return null;
  const area = G.areas.find(a => lat >= a.south && lat < a.north) || (lat >= 42 ? G.areas[0] : G.areas[G.areas.length - 1]);
  const { md, ymd } = todayMMDD();
  const expired = G.valid_through && ymd > G.valid_through;
  const rows = [];
  for (const grp of ["nearshore", "shelf"]) {
    const per = area[grp].find(p => md >= p.from && md <= p.to);
    const row = { grp, label: G.groups[grp], rule: per?.rule, fm: per?.fm, until: per?.to };
    if (expired) { row.status = "unknown"; row.text = "This year's rules aren't loaded yet"; }
    else if (!per) { row.status = "unknown"; row.text = "No rule found"; }
    else if (per.rule === "closed") { row.status = "closed"; row.text = "Closed (boat-based)"; }
    else if (per.rule === "all") { row.status = "open"; row.text = "Open at all depths"; }
    else {
      const parts = D.lines[String(per.fm)] || [];
      const sea = Geo.seaward(parts, lon, lat);
      const dist = Geo.lineDist(parts, lon, lat);
      const ok = per.rule === "inshore" ? !sea : sea;
      row.side = sea ? "seaward" : "shoreward";
      row.dist = dist;
      row.near = dist <= tol;
      row.status = row.near ? "near" : ok ? "open" : "closed";
      row.text = `${per.rule === "inshore" ? "Inside" : "Outside"} ${per.fm} fm line only · you're ${row.side}, ${Geo.fmtDist(dist)} from it`;
    }
    rows.push(row);
  }
  return { area, rows, expired };
}

/* ------------------------------------------------------------------ rendering: Here */
const cls = (v, ok) => ok.includes(v) ? v : "";
const COLORS = { red: "#d7263d", amber: "#f29e0b", violet: "#7b4fd6", green: "#1b9e5a" };
function fmtUntil(md) {
  const [m, d] = md.split("-").map(Number);
  return new Date(2000, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function render(ev, source) {
  const b = $("banner");
  let klass, kicker, title, sub, key;
  const top = ev.inside[0];
  if (top) {
    const p = top.f.properties;
    klass = cls(p.color, ["red", "amber", "violet"]); key = "in:" + p.name;
    kicker = p.color === "red" ? "Inside an MPA" : p.color === "violet" ? "Inside a special closure" : "Inside an MPA";
    title = p.headline;
    sub = `${esc(p.full)}<br>${esc(p.summary)}`;
    if (top.e.d <= Math.max(ev.acc || 0, 10)) sub += `<br><b>Near the edge</b> (${Geo.fmtDist(top.e.d)} away)`;
  } else if (ev.near.length) {
    const p = ev.near[0].f.properties;
    klass = "near"; key = "near:" + p.name;
    kicker = "Near an MPA boundary";
    title = "Treat as inside";
    sub = `${esc(p.full)} is ${Geo.fmtDist(ev.near[0].e.d)} ${Geo.compass(ev.near[0].e.bearing)}, within your GPS accuracy.<br>${esc(p.headline)}: ${esc(p.summary)}`;
  } else {
    klass = "green"; key = "out";
    kicker = "Outside all MPAs";
    title = "No MPA here";
    const n = ev.nearest;
    sub = n ? `Nearest: <b>${esc(n.f.properties.name)}</b> · ${Geo.fmtDist(n.e.d)} ${Geo.compass(n.e.bearing)} <span class="pill ${cls(n.f.properties.color, ["red","amber","violet"])}">${esc(n.f.properties.headline)}</span>` : "";
  }
  b.className = "banner " + klass;
  $("bKicker").textContent = kicker;
  $("bTitle").textContent = title;
  $("bSub").innerHTML = sub;

  // groundfish panel
  const gf = ev.gf;
  if (gf) {
    $("gfArea").textContent = gf.area.name + " area";
    $("gfRows").innerHTML = gf.rows.map(r => `
      <div class="gf-row ${r.status}">
        <span class="gf-dot">${r.status === "open" ? "✓" : r.status === "closed" ? "✕" : "!"}</span>
        <div><div class="gf-l">${esc(r.label)}</div><div class="gf-t">${esc(r.text)}${r.until && r.status !== "unknown" ? ` · until ${fmtUntil(r.until)}` : ""}</div></div>
      </div>`).join("") + (ev.excl.length ? `<div class="gf-row closed"><span class="gf-dot">✕</span><div><div class="gf-l">Groundfish Exclusion Area: ${esc(ev.excl[0].properties.name)}</div><div class="gf-t">Groundfish fishing restricted here (§27.50)</div></div></div>` : "");
    $("gfFoot").innerHTML = `Shore anglers and divers are exempt from groundfish seasons and depths. Never keep: ${esc(D.groundfish.no_retention.join(", "))}.` +
      (gf.area.note ? `<br>${esc(gf.area.note)}` : "");
  }

  // MPA detail panel (inside or near)
  const shown = ev.inside[0] || ev.near[0];
  const mp = $("mpaPanel");
  if (shown) {
    const p = shown.f.properties;
    mp.hidden = false;
    mp.innerHTML = `<div class="p-head"><span>${esc(p.full)}</span><span class="pill ${cls(p.color, ["red","amber","violet"])}">${esc(p.type)}</span></div>
      <p>${esc(p.summary)}</p>
      ${p.legal ? `<details><summary>Regulation text (${esc(p.ccr || "14 CCR 632")})</summary><p class="legal">${esc(p.legal)}</p></details>` : ""}`;
  } else mp.hidden = true;

  // auto region for rules tab
  if (!state.regionPinned && ev.region !== state.region) { state.region = ev.region; renderRules(); }

  // buzz on change (GPS only)
  if (source === "gps" && state.lastKey && key !== state.lastKey && navigator.vibrate) {
    navigator.vibrate(klass === "green" ? [120] : [250, 120, 250, 120, 250]);
  }
  if (source === "gps") state.lastKey = key;
}

/* ------------------------------------------------------------------ map */
let map, meMarker, accCircle, pinMarker, depthLayer;
function initMap() {
  map = L.map("map", { zoomControl: false, attributionControl: true, preferCanvas: true }).setView([35.25, -120.9], 10);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  // Offline backdrop: built-in coastline under any tiles
  if (D.coast) L.geoJSON(D.coast, { interactive: false, style: { color: "#b9a77f", weight: 1, fillColor: "#efe6cf", fillOpacity: 1 } }).addTo(map);
  const streets = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "© OpenStreetMap" });
  const sat = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 18, attribution: "Imagery © Esri" });
  const ocean = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}", { maxZoom: 13, attribution: "© Esri, GEBCO, NOAA" });
  let base = localStorageGet("base", "streets");
  const bases = { "Streets": streets, "Satellite": sat, "Ocean depth": ocean, "Offline coastline only": L.layerGroup() };
  const names = { streets: "Streets", sat: "Satellite", ocean: "Ocean depth", none: "Offline coastline only" };
  (bases[names[base]] || streets).addTo(map);
  map.on("baselayerchange", e => localStorageSet("base", Object.keys(names).find(k => names[k] === e.name)));

  const mpaLayer = L.geoJSON(D.mpa, {
    style: f => ({ color: COLORS[f.properties.color], weight: 2, fillColor: COLORS[f.properties.color], fillOpacity: 0.22 }),
    onEachFeature: (f, l) => l.on("click", e => { L.DomEvent.stopPropagation(e); checkPin(e.latlng); })
  }).addTo(map);
  const excl = L.geoJSON(D.exclusion, { style: { color: "#444", weight: 1.5, dashArray: "4 3", fillColor: "#444", fillOpacity: 0.12 } });
  const lines = L.layerGroup();
  for (const fm of Object.keys(D.lines)) {
    for (const part of D.lines[fm]) {
      L.polyline(part.map(c => [c[1], c[0]]), { color: "#0b3b5c", weight: fm === "50" ? 1.6 : 1, opacity: 0.55, dashArray: "6 5", interactive: false }).addTo(lines);
    }
  }
  depthLayer = L.layerGroup().addTo(map);
  excl.addTo(map);
  L.control.layers(bases, { "MPAs": mpaLayer, "Depth lines (30–150 fm)": lines, "Groundfish exclusion areas": excl }, { position: "topright" }).addTo(map);
  highlightActiveLine();

  const loc = L.control({ position: "bottomright" });
  loc.onAdd = () => { const d = L.DomUtil.create("button", "locbtn"); d.innerHTML = "◎"; d.title = "My location"; d.onclick = e => { L.DomEvent.stop(e); backToGps(); }; return d; };
  loc.addTo(map);
  map.on("click", e => checkPin(e.latlng));
  map.on("dragstart", () => { state.follow = false; });
}

function highlightActiveLine() {
  depthLayer.clearLayers();
  const fms = new Set();
  const { md } = todayMMDD();
  for (const a of D.groundfish.areas) for (const g of ["nearshore", "shelf"]) {
    const p = a[g].find(p => md >= p.from && md <= p.to);
    if (p && p.fm) fms.add(String(p.fm));
  }
  for (const fm of fms) for (const part of D.lines[fm] || [])
    L.polyline(part.map(c => [c[1], c[0]]), { color: "#d7263d", weight: 2.5, opacity: 0.9, interactive: false }).addTo(depthLayer);
}

function checkPin(latlng) {
  state.pin = latlng;
  if (!pinMarker) pinMarker = L.marker(latlng).addTo(map); else pinMarker.setLatLng(latlng).addTo(map);
  $("pinNote").hidden = false;
  render(evaluate(latlng.lat, latlng.lng, 0), "pin");
}
function backToGps() {
  state.pin = null; state.follow = true;
  if (pinMarker) map.removeLayer(pinMarker);
  $("pinNote").hidden = true;
  if (state.gps) { map.setView([state.gps.lat, state.gps.lon], Math.max(map.getZoom(), 13)); render(evaluate(state.gps.lat, state.gps.lon, state.gps.acc), "gps"); }
}
$("backToGps").onclick = backToGps;

/* ------------------------------------------------------------------ GPS */
function startGps() {
  if (!navigator.geolocation) { $("gpsState").textContent = "No GPS on this device"; return; }
  navigator.geolocation.watchPosition(pos => {
    const { latitude: lat, longitude: lon, accuracy: acc } = pos.coords;
    const first = !state.gps;
    state.gps = { lat, lon, acc };
    $("gpsState").textContent = `GPS ±${Math.round(acc * 3.28084)} ft`;
    $("gpsState").className = "gps " + (acc < 30 ? "good" : acc < 100 ? "ok" : "poor");
    const ll = [lat, lon];
    if (!meMarker) {
      accCircle = L.circle(ll, { radius: acc, color: "#1e88e5", weight: 1, fillOpacity: 0.12, interactive: false }).addTo(map);
      meMarker = L.circleMarker(ll, { radius: 8, color: "#fff", weight: 3, fillColor: "#1e88e5", fillOpacity: 1, interactive: false }).addTo(map);
    } else { meMarker.setLatLng(ll); accCircle.setLatLng(ll).setRadius(acc); }
    if (first) map.setView(ll, 13); else if (state.follow && !state.pin) map.panTo(ll, { animate: true });
    if (!state.pin) render(evaluate(lat, lon, acc), "gps");
  }, err => {
    $("gpsState").textContent = err.code === 1 ? "Location blocked" : "GPS unavailable";
    $("gpsState").className = "gps poor";
    if (!state.gps) {
      $("bTitle").textContent = err.code === 1 ? "Location is blocked" : "Can't get a GPS fix";
      $("bSub").innerHTML = err.code === 1 ? "Allow location for this site in your browser settings. Meanwhile, tap the map to check any spot." : "Tap the map to check any spot.";
    }
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
}

/* ------------------------------------------------------------------ Rules tab */
function renderRules() {
  const regs = D.regs || [];
  const cur = state.region || "central";
  $("regionChips").innerHTML = regs.map(r => `<button class="chip ${r.key === cur ? "on" : ""}" data-r="${esc(r.key)}">${esc(r.name)}</button>`).join("");
  $("regionChips").querySelectorAll(".chip").forEach(c => c.onclick = () => { state.region = c.dataset.r; state.regionPinned = true; renderRules(); });
  const r = regs.find(x => x.key === cur);
  if (!r) return;
  $("regsHead").innerHTML = `<div class="rh-t">${esc(r.label)}</div>
    <div class="rh-s">CDFW summary updated ${esc(r.updated || "?")} · <a href="${safeUrl(r.url)}" target="_blank" rel="noopener noreferrer">View on CDFW</a></div>
    ${[...new Set(r.notes)].map(n => `<details class="note"><summary><b>Alert:</b> ${esc(n.replace(/^NOTE:\s*/, "").slice(0, 90))}… <u>more</u></summary>${esc(n.replace(/^NOTE:\s*/, ""))}</details>`).join("")}`;
  const q = ($("regsSearch").value || "").toLowerCase();
  const cards = r.cards.filter(c => !q || (c.title + " " + c.text.join(" ")).toLowerCase().includes(q));
  const pinned = PINNED.map(id => cards.find(c => c.id === id)).filter(Boolean);
  const rest = cards.filter(c => !PINNED.includes(c.id));
  const gfIds = ["rockfish", "lingcod", "cabezon", "greenlings"];
  const card = c => {
    const gf = gfIds.includes(c.id) ? groundfishCard(c.id, cur) : "";
    const st = { open: "Open", partial: "Partly closed / alert", closed: "Closed" }[c.status] || c.status;
    return `<details class="rcard ${cls(c.status, ["open","partial","closed"])}">
      <summary><span class="rc-t">${esc(c.title)}</span><span class="pill ${cls(c.status, ["open","partial","closed"])}">${esc(st)}</span>
        ${!gf && (c.bag || c.size) ? `<div class="rc-q">${c.bag ? `Bag: ${esc(c.bag)}` : ""}${c.bag && c.size ? " · " : ""}${c.size ? `Min size: ${esc(c.size)}` : ""}</div>` : ""}
        ${gf ? `<div class="rc-q">${gf.quick}</div>` : ""}</summary>
      ${gf ? gf.body : c.text.map(t => `<p>${esc(t)}</p>`).join("")}
      <a class="src" href="${safeUrl(c.url)}" target="_blank" rel="noopener noreferrer">CDFW: ${esc(c.title)} ↗</a>
    </details>`;
  };
  $("regsList").innerHTML = (pinned.length ? `<div class="sec">Your species</div>${pinned.map(card).join("")}` : "") +
    (rest.length ? `<div class="sec">Everything else</div>${rest.map(card).join("")}` : "");
}

function groundfishCard(id, regionKey) {
  const G = D.groundfish;
  const areaKey = regionKey === "sfbay" ? "sanfrancisco" : regionKey;
  const a = G.areas.find(x => x.key === areaKey) || G.areas[3];
  const grp = id === "lingcod" ? "shelf" : "nearshore";
  const { md } = todayMMDD();
  const ruleTxt = p => p.rule === "closed" ? "Closed" : p.rule === "all" ? "Open, all depths" : p.rule === "inshore" ? `Only inside the ${p.fm} fm line` : `Only outside the ${p.fm} fm line`;
  const now = a[grp].find(p => md >= p.from && md <= p.to);
  const bagRows = G.bag.filter(b => id === "lingcod" ? b.species === "Lingcod" : b.species !== "Lingcod");
  const quick = `${now ? ruleTxt(now) : "?"} now (boat) · ${id === "lingcod" ? "2 fish, 22 in. min" : "10 RCG combined"}`;
  const sched = g => a[g].map(p => `<tr class="${p === a[g].find(q => md >= q.from && md <= q.to) ? "now" : ""}"><td>${fmtUntil(p.from)} – ${fmtUntil(p.to)}</td><td>${ruleTxt(p)}</td></tr>`).join("");
  const body = `
    <p><b>${esc(a.name)} management area</b>, boat-based season (rules through ${esc(G.valid_through)}):</p>
    <table class="tbl"><tr><th colspan="2">${esc(G.groups.nearshore)}</th></tr>${sched("nearshore")}
      <tr><th colspan="2">${esc(G.groups.shelf)}</th></tr>${sched("shelf")}</table>
    <table class="tbl"><tr><th>Species</th><th>Bag</th><th>Size</th></tr>${bagRows.map(b => `<tr><td>${esc(b.species)}</td><td>${esc(b.bag)}</td><td>${esc(b.size)}</td></tr>`).join("")}</table>
    <p class="warn">Never keep: ${esc(G.no_retention.join(", "))}.</p>
    ${G.notes.map(n => `<p>${esc(n)}</p>`).join("")}
    <p class="muted">From CDFW's groundfish summary (updated ${esc(G.source_updated)}), checked ${esc(G.checked)}.</p>`;
  return { quick, body };
}
$("regsSearch").oninput = () => renderRules();

/* ------------------------------------------------------------------ Fish ID tab */
let idFilter = "all";
function renderId() {
  const sp = D.species?.species || [];
  const chips = [["all", "All"], ["nokeep", "Never keep"], ["rockfish", "Rockfish"], ["other", "Other fish"], ["invert", "Crabs"]];
  $("idChips").innerHTML = chips.map(([k, l]) => `<button class="chip ${k === idFilter ? "on" : ""}" data-k="${k}">${l}</button>`).join("");
  $("idChips").querySelectorAll(".chip").forEach(c => c.onclick = () => { idFilter = c.dataset.k; renderId(); });
  const q = ($("idSearch").value || "").toLowerCase();
  const list = sp.filter(s => (idFilter === "all" || (idFilter === "nokeep" ? s.nokeep : s.group === idFilter)) &&
    (!q || (s.name + " " + (s.aka || []).join(" ") + " " + s.sci).toLowerCase().includes(q)));
  $("idList").innerHTML = list.map(s => `
    <details class="fcard ${s.nokeep ? "nokeep" : ""}">
      <summary>
        ${safePhoto(s.photo) ? `<img loading="lazy" src="${safePhoto(s.photo)}" alt="">` : `<div class="noimg">no photo</div>`}
        <div class="fc-h"><div class="fc-n">${esc(s.name)}</div><div class="fc-s"><i>${esc(s.sci)}</i>${s.aka?.length ? " · " + esc(s.aka.join(", ")) : ""}</div>
        ${s.nokeep ? `<span class="pill red">Never keep</span>` : s.tag ? `<span class="pill amber">${esc(s.tag)}</span>` : ""}</div>
      </summary>
      <ul>${s.features.map(f => `<li>${esc(f)}</li>`).join("")}</ul>
      ${s.lookalikes?.length ? `<div class="sec2">Don't confuse with</div>${s.lookalikes.map(l => `<p><b>${esc(l.name)}</b>: ${esc(l.how)}</p>`).join("")}` : ""}
      ${s.regs ? `<p class="muted">${esc(s.regs)}</p>` : ""}
      ${s.photo_credit ? `<p class="credit">Photo: ${esc(s.photo_credit)}</p>` : ""}
    </details>`).join("") || `<p class="muted">No matches.</p>`;
}
$("idSearch").oninput = () => renderId();

/* ------------------------------------------------------------------ Info tab */
function daysSince(iso) { return iso ? (Date.now() - new Date(iso).getTime()) / 864e5 : Infinity; }
function renderInfo() {
  const m = D.meta || {}, s = m.sources || {};
  const age = daysSince(m.built_at);
  const stale = age > STALE_DAYS;
  $("stale").hidden = !stale;
  $("stale").textContent = `Data is ${Math.floor(age)} days old. Connect to the internet and reopen LineCheck to refresh, and double-check CDFW before fishing.`;
  $("infoBody").innerHTML = `
    <h2>About LineCheck</h2>
    <p>LineCheck tells you whether your current position is inside a California Marine Protected Area or a groundfish depth closure, and shows CDFW's regional fishing rules and species ID tips. Everything works offline once loaded.</p>
    <p class="warn">LineCheck is a guide, not legal advice. Official CDFW regulations always win. GPS can be off by tens of feet, so give boundaries room.</p>
    <h3>Data</h3>
    <table class="tbl">
      <tr><td>Data last refreshed</td><td>${m.built_at ? new Date(m.built_at).toLocaleDateString() : "?"} ${stale ? "⚠️" : ""}</td></tr>
      <tr><td>MPA boundaries</td><td>CDFW ${esc(s.mpa?.title || "")} (${s.mpa?.count || "?"} areas)</td></tr>
      <tr><td>MPA rules</td><td>14 CCR §632</td></tr>
      <tr><td>Groundfish rules</td><td>CDFW summary updated ${esc(s.groundfish_page_updated || "?")}; seasons checked ${esc(s.groundfish_rules_checked || "?")}</td></tr>
      ${Object.entries(s.regs || {}).map(([k, v]) => `<tr><td>Rules: ${esc(k)}</td><td>updated ${esc(v || "?")}</td></tr>`).join("")}
    </table>
    <h3>How it decides</h3>
    <p><b>MPAs:</b> your position is tested against CDFW's MPA polygons. If you're outside but within your GPS accuracy of a boundary, LineCheck says to treat it as inside.</p>
    <p><b>Depth closures:</b> legal depth limits are lines of official waypoints (50 CFR 660), not your depth sounder. LineCheck checks which side of the active line you're on.</p>
    <p><b>Buzz:</b> your phone vibrates when your status changes, while LineCheck is open and the screen is on.</p>
    <h3>Links</h3>
    <p><a href="https://wildlife.ca.gov/Fishing/Ocean/Regulations/Groundfish-Summary" target="_blank" rel="noopener">CDFW groundfish summary</a><br>
    <a href="https://wildlife.ca.gov/Fishing/Ocean/Regulations/Inseason" target="_blank" rel="noopener">CDFW in-season changes</a><br>
    <a href="https://wildlife.ca.gov/Conservation/Marine/MPAs" target="_blank" rel="noopener">CDFW marine protected areas</a></p>
    <p class="muted">Map tiles you view are saved for offline use. Pre-scroll your spots at home while you have signal.</p>`;
}

/* ------------------------------------------------------------------ tabs, storage, boot */
function localStorageGet(k, d) { try { return localStorage.getItem("lc_" + k) ?? d; } catch { return d; } }
function localStorageSet(k, v) { try { localStorage.setItem("lc_" + k, v); } catch { } }
document.querySelectorAll(".tabs button").forEach(b => b.onclick = () => {
  document.querySelectorAll(".tabs button").forEach(x => x.classList.toggle("on", x === b));
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.id === "tab-" + b.dataset.tab));
  if (b.dataset.tab === "here") setTimeout(() => map.invalidateSize(), 50);
});

(async function boot() {
  await loadData();
  initMap();
  renderRules(); renderId(); renderInfo();
  startGps();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => { });
})();
