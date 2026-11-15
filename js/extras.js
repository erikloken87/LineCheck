/* Settings (theme, sound), boundary arrow, weather warnings, tides tab, trip planner and bag counter. */
const Store = { get(k, d) { try { return JSON.parse(localStorage.getItem("lc_" + k)) ?? d; } catch { return d; } },
                set(k, v) { try { localStorage.setItem("lc_" + k, JSON.stringify(v)); } catch { } } };
const LA = (() => {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", hour12: false, weekday: "short" });
  function parts(ts) { const o = {}; for (const p of f.formatToParts(new Date(ts))) o[p.type] = p.value; return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, dow: o.weekday }; }
  // start of the Los Angeles calendar day containing ts (handles daylight saving)
  function dayStart(ts) { const p = parts(ts); for (const off of [8, 7]) { const t = Date.UTC(p.y, p.m - 1, p.d, off); const q = parts(t); if (q.h === 0 && q.d === p.d) return t; } return Date.UTC(p.y, p.m - 1, p.d, 8); }
  const time = ts => new Date(ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" }).replace(" AM", "a").replace(" PM", "p");
  const date = (ts, o) => new Date(ts).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", ...o });
  return { parts, dayStart, time, date };
})();

/* ------------------------------------------------------------------ settings: theme + sound */
const Settings = (() => {
  let ctx = null;
  const theme = () => Store.get("theme", "auto");
  function apply() {
    const t = theme();
    const eff = t === "auto" ? (window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : t;
    document.documentElement.dataset.theme = eff;
    const m = document.querySelector('meta[name="theme-color"]'); if (m) m.content = eff === "sun" ? "#000000" : eff === "dark" ? "#0a2a42" : "#0b3b5c";
  }
  apply();
  if (window.matchMedia) matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", apply);
  const soundOn = () => Store.get("sound", false);
  function beep(kind) {
    if (!soundOn()) return;
    try {
      ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === "suspended") ctx.resume();
      const tones = kind === "ok" ? [[660, 0, .18]] : [[880, 0, .2], [880, .3, .2], [880, .6, .35]];
      for (const [hz, at, len] of tones) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = "square"; o.frequency.value = hz; g.gain.value = 0.25;
        o.connect(g); g.connect(ctx.destination); o.start(ctx.currentTime + at); o.stop(ctx.currentTime + at + len);
      }
    } catch { }
  }
  function render() {
    const P = document.getElementById("settingsBody"); if (!P) return;
    const chips = (name, cur, opts) => `<div class="chips">${opts.map(([k, l]) => `<button class="chip ${String(k) === String(cur) ? "on" : ""}" data-set="${name}" data-v="${k}">${l}</button>`).join("")}</div>`;
    P.innerHTML = `<div class="panel" style="margin-top:0">
      <div class="p-head"><span>Settings</span></div>
      <div class="set-row"><div><b>Look</b><div class="muted">Sun = high contrast and bigger text for bright days</div></div></div>
      ${chips("theme", theme(), [["auto", "Auto"], ["light", "Light"], ["dark", "Dark"], ["sun", "Sun"]])}
      <div class="set-row"><div><b>Sound alarm</b><div class="muted">Beeps when you cross into or out of a protected area, as well as buzzing. Works while the app is open.</div></div></div>
      ${chips("sound", soundOn(), [[false, "Off"], [true, "On"]])}
    </div>`;
    P.querySelectorAll("[data-set]").forEach(b => b.onclick = () => {
      if (b.dataset.set === "theme") { Store.set("theme", b.dataset.v); apply(); }
      else { Store.set("sound", b.dataset.v === "true"); if (b.dataset.v === "true") beep("alert"); }
      render();
    });
  }
  return { apply, beep, render };
})();

/* ------------------------------------------------------------------ arrow to the nearest boundary */
function renderGuide(ev) {
  const G = $("guide");
  const top = ev.inside[0], near = ev.near[0], n = ev.nearest;
  const tgt = top ? { e: top.e, lbl: "nearest way out" } : near ? { e: near.e, lbl: "MPA boundary" } : n && n.e && n.e.d < 16000 ? { e: n.e, lbl: "to nearest MPA" } : null;
  if (!tgt) { G.hidden = true; return; }
  G.hidden = false;
  $("guideArrow").style.transform = `rotate(${Math.round(tgt.e.bearing)}deg)`;
  $("guideDist").textContent = `${Geo.fmtDist(tgt.e.d)} ${Geo.compass(tgt.e.bearing)}`;
  $("guideLbl").textContent = tgt.lbl;
}

/* ------------------------------------------------------------------ marine weather warnings (National Weather Service) */
// Warnings that cover a spot (marine zones by containment; beach zones if within ~6 miles), including ones starting later
function alertsAt(lat, lon) {
  const C = D.conditions, now = Date.now(), hit = [];
  for (const a of C?.alerts || []) {
    if (a.ends && new Date(a.ends) < now) continue;
    const z = a.zones.map(id => [id, C.zones[id]]).find(([id, z]) => z && (Geo.contains(z.geom, lon, lat) ||
      (id.startsWith("CAZ") && Geo.edgeDist(Geo.geomRings(z.geom), lon, lat).d < 10000)));
    if (z && !hit.some(h => h.event === a.event && h.ends === a.ends)) hit.push({ ...a, zone: z[1].name });
  }
  return hit;
}
function renderWx(lat, lon) {
  const W = $("wx"), C = D.conditions;
  if (!C || !("alerts" in C)) { W.hidden = true; return; }
  if (C.alerts === null) { W.hidden = false; W.className = "wx"; W.innerHTML = `Couldn't check weather warnings on the last update. See <a href="https://www.weather.gov/marine" target="_blank" rel="noopener noreferrer">weather.gov/marine</a>.`; return; }
  const now = Date.now(), hit = alertsAt(lat, lon).filter((a, i, arr) => arr.findIndex(b => b.event === a.event) === i);
  if (!hit.length) { W.hidden = true; return; }
  const sevRank = s => ({ Extreme: 0, Severe: 1, Moderate: 2, Minor: 3 }[s] ?? 4);
  hit.sort((a, b) => sevRank(a.severity) - sevRank(b.severity));
  const until = a => a.ends ? ` until ${LA.date(a.ends, { weekday: "short" })} ${LA.time(a.ends)}` : "";
  W.hidden = false;
  W.className = "wx" + (sevRank(hit[0].severity) <= 1 || /Warning/.test(hit[0].event) ? " sev" : "");
  const openWas = W.querySelector("details")?.open;
  W.innerHTML = `<details ${openWas ? "open" : ""}><summary>${esc(hit[0].event)}${esc(until(hit[0]))}${hit.length > 1 ? ` · +${hit.length - 1} more` : ""}</summary>
    ${hit.map(a => `<p><b>${esc(a.event)}</b>${esc(until(a))} · ${esc(a.zone || "")}<br>${esc(a.desc)}${a.desc.length >= 700 ? "…" : ""}</p>`).join("")}
    <p class="muted">From the National Weather Service, checked ${esc(ago(C.updated))}. Warnings can change between checks: see <a href="https://www.weather.gov/marine" target="_blank" rel="noopener noreferrer">weather.gov/marine</a> before you go.</p></details>`;
}

/* ------------------------------------------------------------------ where the Plan/Tides tabs are looking */
const Spot = (() => {
  let sel = 0;
  function list() {
    const cur = visAt ? { name: visAt.source === "pin" ? "Tapped spot" : "Your location", lat: visAt.lat, lon: visAt.lon, cur: true }
      : state.gps ? { name: "Your location", lat: state.gps.lat, lon: state.gps.lon, cur: true } : null;
    return [...(cur ? [cur] : []), ...Vis.spots().map((s, i) => ({ ...s, saved: i }))];
  }
  function current() { const l = list(); if (sel >= l.length) sel = 0; return l[sel] || null; }
  return { list, current, select: i => { sel = i; }, index: () => sel };
})();

/* ------------------------------------------------------------------ tides */
const Tides = (() => {
  const FT = 3.28084, DAY = 864e5;
  let weekOff = 0, openDay = null;
  const minusCache = {};
  const ex = (st, a, b) => st.p.getExtremesPrediction({ start: new Date(a), end: new Date(b) }).map(e => ({ t: +e.time, ft: e.level * FT, high: e.high }));
  const curve = (st, a, b, sec) => st.p.getTimelinePrediction({ start: new Date(a), end: new Date(b), timeFidelity: sec }).map(x => ({ t: +x.time, ft: x.level * FT }));
  const ft1 = v => (v < 0 ? "−" : "") + Math.abs(v).toFixed(1);
  const Y0 = -2.2, Y1 = 7.6;

  function daylightLow(lon, lat, dayIndex) {       // lowest low between sunrise and sunset, for the planner
    const st = Vis.predictor(lon, lat); if (!st) return null;
    const ds = LA.dayStart(Date.now() + dayIndex * DAY + 3600e3);
    const sun = SunCalc.getTimes(new Date(ds + 12 * 3600e3), lat, lon);
    const lows = ex(st, ds, ds + 25 * 3600e3).filter(e => !e.high && e.t >= +sun.sunrise && e.t <= +sun.sunset);
    return lows.length ? lows.reduce((a, b) => b.ft < a.ft ? b : a) : null;
  }
  function svgCurve(pts, a, b, W, H, extra) {
    const x = t => (t - a) / (b - a) * W, y = v => 6 + (Y1 - v) / (Y1 - Y0) * (H - 12);
    const d = "M" + pts.map(p => `${x(p.t).toFixed(1)} ${y(p.ft).toFixed(1)}`).join(" L");
    return `<svg class="tsvg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:${H}px">
      ${extra ? extra(x, y) : ""}
      <line x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}" stroke="var(--red)" stroke-dasharray="4 4" opacity=".5"/>
      <path d="${d} L${W} ${H} L0 ${H} Z" fill="var(--acc)" opacity=".14"/>
      <path d="${d}" fill="none" stroke="var(--acc)" stroke-width="2.200" vector-effect="non-scaling-stroke"/></svg>`;
  }
  function render() {
    const P = $("tidesBody"), at = Spot.current() || { name: "Port San Luis", lat: 35.17, lon: -120.76 };
    const st = window.TidePredictor && Vis.predictor(at.lon, at.lat);
    if (!st) { P.innerHTML = `<p class="muted">No tide station within 50 miles of this spot.</p>`; return; }
    const today = LA.dayStart(Date.now());
    const days = []; for (let i = 0; i < 7; i++) days.push(LA.dayStart(today + (weekOff * 7 + i) * DAY + 12 * 3600e3));
    const end = LA.dayStart(days[6] + 36 * 3600e3);
    const all = ex(st, days[0], end);
    const wk = curve(st, days[0], end, 1800);
    const nowT = Date.now();
    const rows = days.map((ds, i) => {
      const de = i < 6 ? days[i + 1] : end, p = LA.parts(ds + 12 * 3600e3);
      const list = all.filter(e => e.t >= ds && e.t < de);
      let detail = "";
      if (openDay === ds) {
        const sun = SunCalc.getTimes(new Date(ds + 12 * 3600e3), at.lat, at.lon);
        const pts = curve(st, ds, de, 600);
        detail = `<div class="tday">` + svgCurve(pts, ds, de, 340, 150, (x, y) =>
          `<rect x="0" y="0" width="${x(+sun.sunrise)}" height="150" fill="var(--ink)" opacity=".1"/><rect x="${x(+sun.sunset)}" y="0" width="${340 - x(+sun.sunset)}" height="150" fill="var(--ink)" opacity=".1"/>` +
          (nowT >= ds && nowT < de ? `<line x1="${x(nowT)}" x2="${x(nowT)}" y1="0" y2="150" stroke="var(--ink)" stroke-dasharray="2 3"/>` : "") +
          list.map(e => `<circle cx="${x(e.t)}" cy="${y(e.ft)}" r="3.500" fill="${e.high ? "var(--acc)" : "var(--amber)"}"/>`).join("")) +
          `<div class="muted">Shaded = night · sunrise ${LA.time(+sun.sunrise)}, sunset ${LA.time(+sun.sunset)} · dashed red line = 0 ft</div></div>`;
      }
      return `<button class="trow ${openDay === ds ? "open" : ""} ${ds === today ? "today" : ""}" data-ds="${ds}">
        <div class="td"><span>${p.dow}</span><b>${p.d}</b></div>
        <div class="tt">${list.map(e => `<div class="${e.high ? "H" : "L"} ${!e.high && e.ft < 0 ? "neg" : ""}"><b>${e.high ? "▲" : "▼"} ${ft1(e.ft)}</b> <span>${LA.time(e.t)}</span></div>`).join("")}</div></button>${detail}`;
    }).join("");
    if (!minusCache[st.id]) {
      minusCache[st.id] = ex(st, nowT, nowT + 120 * DAY).filter(e => {
        if (e.high || e.ft > -0.5) return false;
        const s = SunCalc.getTimes(new Date(LA.dayStart(e.t) + 12 * 3600e3), at.lat, at.lon); return e.t >= +s.sunrise && e.t <= +s.sunset;
      }).slice(0, 10);
    }
    const title = `${LA.date(days[0] + 432e5, { month: "short", day: "numeric" })} – ${LA.date(days[6] + 432e5, { month: "short", day: "numeric" })}`;
    P.innerHTML = `<div class="bhead" style="margin-top:2px">Tides</div>
      <div class="bsub">${esc(st.name)} station, ${Math.round(st.dist * 0.621)} mi from ${esc(at.name.toLowerCase() === "your location" ? "you" : at.name)} · feet above the average lowest tide</div>
      <div class="tnav"><button id="tPrev" ${weekOff <= 0 ? "disabled" : ""} aria-label="Previous week">‹</button><div class="t">${esc(title)}</div><button id="tNext" aria-label="Next week">›</button></div>
      ${svgCurve(wk, days[0], end, 700, 90, (x) => days.slice(1).map(d => `<line x1="${x(d)}" x2="${x(d)}" y1="0" y2="90" stroke="var(--line)"/>`).join("") + (nowT >= days[0] && nowT < end ? `<line x1="${x(nowT)}" x2="${x(nowT)}" y1="0" y2="90" stroke="var(--ink)" stroke-dasharray="2 3"/>` : ""))}
      ${rows}
      ${weekOff !== 0 ? `<button class="btn2" id="tToday">Back to this week</button>` : ""}
      <div class="sec">Daylight minus tides in the next 4 months</div>
      ${minusCache[st.id].map(e => `<button class="minus" data-t="${e.t}"><span class="h">${ft1(e.ft)}</span><span><b>${LA.date(e.t, { weekday: "short", month: "short", day: "numeric" })}</b><div class="x">Low at ${LA.time(e.t)} · good for tidepools</div></span></button>`).join("") || `<p class="muted">None of −0.5 ft or lower in daylight.</p>`}
      <p class="muted">Calculated on your phone from NOAA's tide constants, so it works offline and for any week. Weather can push the real water a foot or more higher or lower.</p>`;
    $("tPrev").onclick = () => { weekOff--; openDay = null; render(); };
    $("tNext").onclick = () => { weekOff++; openDay = null; render(); };
    if ($("tToday")) $("tToday").onclick = () => { weekOff = 0; openDay = null; render(); };
    P.querySelectorAll(".trow").forEach(b => b.onclick = () => { const ds = +b.dataset.ds; openDay = openDay === ds ? null : ds; render(); });
    P.querySelectorAll(".minus").forEach(b => b.onclick = () => {
      const ds = LA.dayStart(+b.dataset.t); weekOff = Math.floor(Math.round((ds - today) / DAY) / 7); openDay = ds; render();
      P.querySelector(".trow.open")?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }
  return { render, daylightLow, reset: () => { for (const k in minusCache) delete minusCache[k]; } };
})();

/* ------------------------------------------------------------------ trip planner */
function renderPlan() {
  const P = $("planBody"), spots = Spot.list();
  if (!Vis.ready() || !spots.length) { P.innerHTML = `<div class="bhead" style="margin-top:2px">Trip planner</div><p class="muted">Waiting for a location. Tap the map on the Here tab to pick a spot, then save it from the Visibility card.</p>`; return; }
  const sel = Spot.index();
  const short = { rockfish: "Rockfish", lingcod: "Lingcod", halibut: "Halibut", surfperch: "Perch", crab: "Crab" };
  const cards = spots.map((s, i) => {
    const B = Bite.forecast(s.lon, s.lat), out = Vis.outlook(s.lon, s.lat);
    if (!B) return `<div class="pcard ${i === sel ? "sel" : ""}"><div class="pc-h"><button class="pc-n" data-i="${i}">${esc(s.name)}</button>${s.saved != null ? `<button class="pc-x" data-x="${s.saved}" aria-label="Remove">✕</button>` : ""}</div><p class="muted">Too far from the coast for conditions data.</p></div>`;
    const days = B.days.map((label, j) => {
      const top = B.species.map(sp => ({ id: sp.id, d: sp.days[j] })).filter(x => x.d).sort((a, b) => b.d.score - a.d.score)[0];
      const v = out[j], low = Tides.daylightLow(s.lon, s.lat, j);
      return { label, top, v, low, swell: B.meta[j]?.swell, score: (top ? top.d.score : 0) + (v ? Math.min(30, v.ft) : 0) };
    });
    const best = days.reduce((b, d, j) => d.score > days[b].score ? j : b, 0);
    return `<div class="pcard ${i === sel ? "sel" : ""}">
      <div class="pc-h"><button class="pc-n" data-i="${i}">${s.cur ? "◎ " : "★ "}${esc(s.name)}</button>
        <button class="btn2" data-map="${i}" style="padding:4px 10px;font-size:12.500px">Map</button>
        ${s.saved != null ? `<button class="pc-x" data-x="${s.saved}" aria-label="Remove">✕</button>` : ""}</div>
      <div class="pgrid">${days.map((d, j) => `<div class="pday ${j === best ? "best" : ""}">
        <b>${j === best ? `<span class="best-t">Best</span>` : ""}${esc(d.label)}</b>
        <div class="prow"><span>${d.top ? short[d.top.id] : "Bite"}</span>${d.top ? `<span class="pill ${d.top.d.rating}">${BLABEL[d.top.d.rating]}</span>` : "–"}</div>
        <div class="prow"><span>Viz</span>${d.v ? `<span class="pill ${VCLS[d.v.rating]}">${Vis.LABEL[d.v.rating] === "Average" ? "Avg" : Vis.LABEL[d.v.rating]}</span>` : "–"}</div>
        <div class="prow"><span>Swell</span><span>${d.swell != null ? (d.swell * 3.28084).toFixed(0) + " ft" : "–"}</span></div>
        <div class="prow"><span>Low tide</span><span>${d.low ? `${d.low.ft < 0 ? "−" : ""}${Math.abs(d.low.ft).toFixed(1)} ft` : "–"}</span></div>
        ${d.low ? `<div class="prow"><span></span><span>${LA.time(d.low.t)}</span></div>` : ""}
        ${d.top ? `<div class="muted" style="font-size:11.500px;margin-top:3px">${esc(d.top.d.win)}</div>` : ""}
      </div>`).join("")}</div></div>`;
  }).join("");
  P.innerHTML = `<div class="bhead" style="margin-top:2px">Trip planner</div>
    <div class="bsub">Best fishing, visibility, swell reaching the spot, and the lowest daylight tide for the next 3 days. Tap a spot for its bite details.</div>
    ${cards}
    ${Vis.spots().length ? "" : `<p class="muted">Add your regular spots: tap the map on the Here tab, open Visibility, then ☆ Save this spot.</p>`}`;
  P.querySelectorAll(".pc-n").forEach(b => b.onclick = () => { Spot.select(+b.dataset.i); renderPlan(); renderBite(); });
  P.querySelectorAll("[data-map]").forEach(b => b.onclick = () => { const s = spots[+b.dataset.map]; showTab("here"); if (!s.cur) { map.setView([s.lat, s.lon], 13); checkPin(L.latLng(s.lat, s.lon)); } });
  P.querySelectorAll(".pc-x").forEach(b => b.onclick = () => { Vis.removeSpot(+b.dataset.x); Spot.select(0); renderPlan(); renderBite(); });
}

/* ------------------------------------------------------------------ bag counter */
const Bag = (() => {
  const RCG = ["rock", "copper", "verm", "canary", "cab", "green"];
  function items() {
    const lat = state.gps?.lat ?? visAt?.lat ?? 35.2;
    return [
      { id: "rock", name: "Rockfish (other kinds)", lim: 10, note: "counts toward the 10" },
      { id: "verm", name: "Vermilion / sunset rockfish", lim: lat >= 40.1667 ? 4 : 2, note: "sub-limit, counts toward the 10" },
      { id: "canary", name: "Canary rockfish", lim: 2, note: "sub-limit, counts toward the 10" },
      { id: "copper", name: "Copper rockfish", lim: 1, note: "sub-limit, counts toward the 10" },
      { id: "cab", name: "Cabezon", lim: 10, note: "counts toward the 10" },
      { id: "green", name: "Greenling", lim: 10, note: "counts toward the 10" },
      { id: "ling", name: "Lingcod", lim: 2, note: "22 in. minimum" },
      { id: "hal", name: "California halibut", lim: lat < 36.3 ? 5 : 3, note: "22 in. minimum" },
      { id: "perch", name: "Surfperch", lim: 20, note: "no more than 10 of one kind" },
      { id: "dung", name: "Dungeness crab", lim: 10, note: "5¾ in. minimum" },
      { id: "rcrab", name: "Rock crab", lim: 35, note: "4 in. minimum" },
    ];
  }
  const today = () => { const p = LA.parts(Date.now()); return `${p.y}-${p.m}-${p.d}`; };
  function load() { const b = Store.get("bag", null); return b && b.date === today() ? b : { date: today(), c: {} }; }
  const total = b => Object.values(b.c).reduce((s, n) => s + n, 0);
  function badge() {
    const n = total(load()), btn = document.querySelector('.tabs button[data-tab="catch"]'); if (!btn) return;
    btn.querySelector(".badge")?.remove();
    if (n) { const s = document.createElement("span"); s.className = "badge"; s.textContent = n; btn.appendChild(s); }
  }
  function render(popId) {
    const P = $("bagBody"), b = load(), it = items();
    const rcg = RCG.reduce((s, id) => s + (b.c[id] || 0), 0);
    const row = x => {
      const n = b.c[x.id] || 0, isR = RCG.includes(x.id);
      const full = n >= x.lim || (isR && rcg >= 10);
      return `<div class="bagrow ${n >= x.lim ? "full" : ""}">
        <div><div class="n">${esc(x.name)}</div><div class="l">Limit ${x.lim} · ${esc(x.note)}</div></div>
        <div class="cnt"><button data-m="${x.id}" ${n ? "" : "disabled"} aria-label="Remove one">−</button><b class="${popId === x.id ? "pop" : ""}">${n}</b><button class="plus" data-p="${x.id}" ${full ? "disabled" : ""} aria-label="Add one">+</button></div>
        ${x.lim <= 10 && !isR || x.lim <= 4 ? `<div class="pips">${Array.from({ length: x.lim }, (_, i) => `<i class="${i < n ? "on" : ""}"></i>`).join("")}</div>` : ""}
      </div>`;
    };
    P.innerHTML = `<div class="panel" style="margin-top:0">
      <div class="bag-h"><span class="bag-t">Today's bag</span><button class="btn2" id="bagReset" ${total(b) ? "" : "disabled"}>Start over</button></div>
      <div class="bagtot"><b>Rockfish, cabezon, greenling: ${rcg} of 10</b>${rcg >= 10 ? " · limit reached, well done" : ""}
        <div class="bar ${rcg >= 10 ? "full" : ""}"><i style="width:${Math.min(100, rcg * 10)}%"></i></div></div>
      ${it.map(row).join("")}
      <div class="sec2" style="margin-top:10px">Never keep</div>
      <div class="nokeep-row">${(D.groundfish?.no_retention || []).map(n => `<span class="pill red">${esc(n)}</span>`).join("")}</div>
      <p class="muted">Counts what you tap, per person, and clears itself each day. Limits shown are the daily bag limits for where you are; check the Rules tab for seasons and anything not listed.</p>
    </div>`;
    P.querySelectorAll("[data-p]").forEach(btn => btn.onclick = () => {
      const id = btn.dataset.p, x = it.find(i => i.id === id), nb = load();
      nb.c[id] = (nb.c[id] || 0) + 1; Store.set("bag", nb);
      const r = RCG.reduce((s, k) => s + (nb.c[k] || 0), 0);
      const hitLimit = nb.c[id] >= x.lim || (RCG.includes(id) && r >= 10);
      if (navigator.vibrate) navigator.vibrate(hitLimit ? [60, 60, 160] : 25);
      render(id); badge();
    });
    P.querySelectorAll("[data-m]").forEach(btn => btn.onclick = () => { const nb = load(); nb.c[btn.dataset.m] = Math.max(0, (nb.c[btn.dataset.m] || 0) - 1); Store.set("bag", nb); render(); badge(); });
    $("bagReset").onclick = () => { Store.set("bag", { date: today(), c: {} }); render(); badge(); };
  }
  return { render, badge };
})();
