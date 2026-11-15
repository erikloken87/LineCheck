/* Rough underwater visibility estimate, tides, saved spots and public diver reports. */
const Vis = (() => {
  const FT = 3.28084, H3 = 3 * 3600e3;
  const st = { cond: null, tides: null, cfg: null, predictors: {}, coast: [], expo: {} };
  const km = (aLon, aLat, bLon, bLat) => Math.hypot((aLon - bLon) * 111.32 * Math.cos(aLat * Math.PI / 180), (aLat - bLat) * 110.57);
  const LS = { get(k, d) { try { return JSON.parse(localStorage.getItem("lc_" + k)) ?? d; } catch { return d; } },
               set(k, v) { try { localStorage.setItem("lc_" + k, JSON.stringify(v)); } catch { } } };

  function init(cond, tides, cfg, coast) {
    st.cond = cond; st.tides = tides; st.cfg = cfg;
    const polys = !coast ? [] : coast.type === "Polygon" ? [coast.coordinates] : coast.coordinates;
    st.coast = polys.map(p => { const r = p[0]; let b = [Infinity, Infinity, -Infinity, -Infinity];
      for (const c of r) { if (c[0] < b[0]) b[0] = c[0]; if (c[1] < b[1]) b[1] = c[1]; if (c[0] > b[2]) b[2] = c[0]; if (c[1] > b[3]) b[3] = c[1]; }
      return { r, b }; });
    flushQueue();
  }

  // ---------------------------------------------------------------- swell sheltering from the coastline shape
  function inLand(x, y) {
    for (const { r, b } of st.coast) {
      if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
      let ins = false;
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) ins = !ins;
      }
      if (ins) return true;
    }
    return false;
  }
  // For each compass bin: 1 if open ocean lies that way, 0 if land (headland, island) blocks it within 80 km.
  function exposure(lon, lat, coarse) {
    const key = `${lon.toFixed(3)},${lat.toFixed(3)},${coarse ? 1 : 0}`;
    if (st.expo[key]) return st.expo[key];
    if (!st.coast.length) return null;
    const bins = coarse ? 18 : 36, step = coarse ? 3 : 1.5, max = coarse ? 60 : 80, out = [];
    const kx = 111.32 * Math.cos(lat * Math.PI / 180);
    for (let b = 0; b < bins; b++) {
      const br = b * (360 / bins) * Math.PI / 180; let open = 1;
      for (let d = 1.5; d <= max; d += step) {
        if (inLand(lon + d * Math.sin(br) / kx, lat + d * Math.cos(br) / 110.57)) { open = 0; break; }
      }
      out.push(open);
    }
    return (st.expo[key] = out);
  }
  // Share of swell from direction `dir` (degrees it comes from) that reaches the spot. Never zero: swell wraps around points.
  function trans(open, dir) {
    if (!open || dir == null) return 1;
    const n = open.length, w0 = 360 / n; let s = 0, t = 0;
    for (let b = 0; b < n; b++) {
      let d = Math.abs(b * w0 - dir) % 360; if (d > 180) d = 360 - d;
      if (d > 50) continue;
      const w = Math.cos(d * Math.PI / 120) ** 2; s += w * open[b]; t += w;
    }
    return 0.2 + 0.8 * (t ? s / t : 1);
  }
  const pf = T => T == null ? 1 : Math.max(0.75, Math.min(1.3, Math.sqrt(T / 10)));   // long-period swell reaches deeper
  const compass = d => ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(d / 45) % 8];

  // ---------------------------------------------------------------- what past reports say about this spot vs the model
  function shrink(r, n) { return Math.exp(Math.log(Math.max(0.5, Math.min(2, r))) * n / (n + 3)); }
  function biasAt(lon, lat) {
    const cell = nearest(st.cond?.bias, lon, lat, c => [c[0], c[1]], 3);
    if (cell) return { r: cell.it[2], n: cell.it[3] };
    const mine = LS.get("myreports", []).filter(r => r.m > 0 && km(lon, lat, r.lon, r.lat) <= 3 && (Date.now() - new Date(r.t)) < 180 * 864e5);
    if (!mine.length) return null;
    return { r: shrink(median(mine.map(r => r.vis / r.m)), mine.length), n: mine.length };
  }

  function median(a) { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; }
  function nearest(list, lon, lat, getLL, maxKm) {
    let best = null, bd = Infinity;
    for (const it of list || []) { const [x, y] = getLL(it); const d = km(lon, lat, x, y); if (d < bd) { bd = d; best = it; } }
    return bd <= maxKm ? { it: best, d: bd } : null;
  }

  // ---------------------------------------------------------------- tides (computed on the phone)
  function tideAt(lon, lat) {
    const s = nearest(st.tides, lon, lat, t => [t.lon, t.lat], 80);
    if (!s || !window.TidePredictor) return null;
    const t = s.it;
    let p = st.predictors[t.id];
    if (!p) p = st.predictors[t.id] = TidePredictor.createTidePredictor(t.hc, { offset: t.offset });
    const now = new Date();
    const ex = p.getExtremesPrediction({ start: new Date(now - 7 * 3600e3), end: new Date(+now + 30 * 3600e3) });
    const next = ex.filter(e => e.time > now).slice(0, 2);
    const prev = ex.filter(e => e.time <= now).pop();
    const lvl = p.getWaterLevelAtTime({ time: now }).level * FT;
    const rising = next[0] ? next[0].high : null;
    return { station: t.name, dist: s.d, level: lvl, rising, next: next.map(e => ({ high: e.high, ft: e.level * FT, time: e.time })), prev };
  }

  // ---------------------------------------------------------------- the estimate
  function swellFactor(h) { return h == null ? 1 : h < 1 ? 1 : h < 2 ? 0.85 : h < 3 ? 0.65 : 0.45; }
  function rainFactor(r) { return r == null ? 1 : r < 5 ? 1 : r < 15 ? 0.8 : r < 40 ? 0.6 : 0.45; }
  function windFactor(w) { return w == null ? 1 : w > 20 ? 0.85 : w > 15 ? 0.93 : 1; }
  const rating = ft => ft < 10 ? "low" : ft < 20 ? "avg" : "high";
  const LABEL = { low: "Low", avg: "Average", high: "High" };

  function reportsNear(lon, lat) {
    const all = [...(st.cond?.reports || []), ...LS.get("myreports", []).map(r => ({ ...r, mine: true }))];
    const now = Date.now(), seen = new Set(), out = [];
    for (const r of all) {
      const age = (now - new Date(r.t)) / 3600e3;
      if (age < -1 || age > 48 || km(lon, lat, r.lon, r.lat) > 2.5) continue;
      const key = `${r.lat},${r.lon},${r.t},${r.vis}`;
      if (seen.has(key)) continue;             // my own report also comes back via the Sheet
      seen.add(key); out.push({ ...r, age });
    }
    return out;
  }
  function weightedMedian(rs) {
    const a = rs.map(r => ({ v: r.vis, w: Math.exp(-r.age / 24) })).sort((x, y) => x.v - y.v);
    const tot = a.reduce((s, x) => s + x.w, 0); let acc = 0;
    for (const x of a) { acc += x.w; if (acc >= tot / 2) return x.v; }
    return a.length ? a[a.length - 1].v : null;
  }

  function estimate(lon, lat, dayOffset = 0, opt = {}) {
    const C = st.cond;
    if (!C) return null;
    const why = [];
    let conf = 2;
    const pt = nearest(C.points, lon, lat, p => [p.lon, p.lat], 20);
    // satellite: median of cells within 3 km, else the nearest within 6 km
    let cells = (C.sat || []).filter(c => km(lon, lat, c[0], c[1]) <= 3);
    const nn = nearest(C.sat, lon, lat, c => [c[0], c[1]], 6);
    if (!cells.length && nn) cells = [nn.it];
    const sat = cells.length ? { it: [0, 0, median(cells.map(c => c[2])), Math.min(...cells.map(c => c[3]))], d: nn ? nn.d : 6 } : null;
    let base;
    if (sat) {
      const [, , kd, age] = sat.it;
      // Kd490 -> diver visibility. Satellite Secchi depth is roughly 1.5/Kd, but horizontal visibility
      // underwater near shore is typically about half of that; 0.8/Kd is a starting calibration that
      // public diver reports then correct locally.
      base = Math.max(3, Math.min(80, (0.8 / kd) * FT));
      if (age <= 1.5 && sat.d <= 4) { conf += 1; why.push(`satellite clarity from ${age < 1 ? "today" : "yesterday"}`); }
      else if (age > 3) { conf -= 1; why.push(`satellite reading is ${Math.round(age)} days old (fog?)`); }
      else why.push(`satellite clarity from ${Math.round(age)} days ago`);
    } else { base = 12; conf -= 1; why.push("no recent satellite reading nearby (fog or too close to shore)"); }

    let h = null, hOff = null, wind = null, sst = null, period = null, sdir = null, idx = 0, shelter = 1, settling = false;
    if (pt) {
      const p = pt.it, t0 = new Date(p.t0 + "Z"), n = (p.wh || []).length;
      const open = exposure(lon, lat, opt.coarse);
      const nowI = Math.max(0, Math.min(n - 1, Math.floor((Date.now() - t0) / H3)));
      // swell that actually reaches the spot: offshore height x sheltering x period effect
      const near = j => p.wh?.[j] == null ? null : p.wh[j] * trans(open, p.wdir?.[j]) * pf(p.wp?.[j]);
      // swell memory: the biggest swell of the last 3 days, fading with a ~30 h settling time
      const heff = i => { let m = null;
        for (let j = Math.max(0, i - 24); j <= i; j++) { const v = near(j); if (v == null) continue; const x = v * Math.exp(-(i - j) * 3 / 30); if (m == null || x > m) m = x; }
        return m; };
      if (dayOffset === 0) { idx = nowI; h = n ? heff(idx) : null; }
      else {
        const a = Math.min(n - 1, nowI + dayOffset * 8 - 2), b = Math.min(n - 1, a + 8); let sum = 0, c = 0;
        for (let i = a; i <= b; i++) { const v = heff(i); if (v != null) { sum += v; c++; } }
        h = c ? sum / c : null; idx = Math.min(n - 1, a + 4);
      }
      hOff = p.wh?.[idx]; period = p.wp?.[idx]; sdir = p.wdir?.[idx]; wind = p.ws?.[idx]; sst = p.sst?.[idx];
      shelter = trans(open, sdir);
      const nowNear = near(idx);
      settling = h != null && nowNear != null && h >= 1.5 && h > nowNear * 1.25;
    }
    let est = base * swellFactor(h) * windFactor(wind);
    if (h != null) why.push(h >= 2 ? "heavy swell stirring up the bottom" : h >= 1 ? "moderate swell reaching this spot" : "little swell reaching this spot");
    if (shelter < 0.6 && hOff >= 1.5 && sdir != null) why.push(`partly sheltered from the ${compass(sdir)} swell`);
    if (settling) why.push("still settling after bigger swell in the last 3 days");
    if (wind != null && wind > 15) why.push(`windy (${Math.round(wind)} kt)`);
    if (dayOffset === 0 && pt) {
      const r = pt.it.rain72;
      est *= rainFactor(r);
      if (r >= 5) why.push(`${(r / 25.4).toFixed(1)} in. of rain in the last 3 days`);
    }
    let tide = null;
    if (dayOffset === 0) {
      tide = tideAt(lon, lat);
      if (tide?.rising && tide.next[0] && (tide.next[0].time - Date.now()) < 2 * 3600e3) { est *= 1.1; why.push("incoming high tide"); }
    }
    const raw = est;                      // the model's own answer, before any diver input
    const bias = biasAt(lon, lat);
    if (bias && Math.abs(bias.r - 1) > 0.07) {
      est *= bias.r;
      why.push(`this spot usually runs ${bias.r > 1 ? "clearer" : "murkier"} than the satellite suggests (${bias.n} past report${bias.n > 1 ? "s" : ""})`);
      if (bias.n >= 3) conf += 1;
    }
    let rep = null;
    if (dayOffset === 0) {
      const rs = reportsNear(lon, lat);
      if (rs.length) {
        const m = weightedMedian(rs);
        const agrees = m > est / 2 && m < est * 2;
        const a = rs.length >= 2 ? Math.min(0.85, 0.5 + 0.15 * (rs.length - 1)) : agrees ? 0.6 : 0.25;
        est = est * (1 - a) + m * a;
        conf += rs.length >= 2 ? 1 : 0;
        rep = { n: rs.length, median: m, newest: Math.min(...rs.map(r => r.age)) };
      }
    }
    est = Math.max(2, Math.min(80, est));
    conf = Math.max(0, Math.min(3, conf));
    return { ft: est, lo: Math.max(1, Math.round(est * 0.7 / 5) * 5 || Math.round(est * 0.7)), hi: Math.max(5, Math.round(est * 1.3 / 5) * 5),
             rating: rating(est), conf: conf <= 1 ? "low" : conf === 2 ? "medium" : "high", why, raw, swell: hOff, period, swellDir: sdir, shelter,
             wind, windDir: pt?.it.wd?.[idx], sst, rain: pt?.it.rain72, tide, rep, updated: C.updated };
  }

  // ---------------------------------------------------------------- saved spots
  const spots = () => LS.get("spots", []);
  function saveSpot(name, lat, lon) { const s = spots(); s.push({ name: name.slice(0, 40), lat: +lat.toFixed(4), lon: +lon.toFixed(4) }); LS.set("spots", s); }
  function removeSpot(i) { const s = spots(); s.splice(i, 1); LS.set("spots", s); }
  function outlook(lon, lat) { return [0, 1, 2].map(d => estimate(lon, lat, d)); }

  // ---------------------------------------------------------------- reports
  const todayKey = () => new Date().toISOString().slice(0, 10);
  function reportsLeftToday() { const c = LS.get("rcount", {}); return Math.max(0, 4 - (c[todayKey()] || 0)); }
  async function submitReport({ lat, lon, vis, temp, act, m }) {
    if (!(vis >= 1 && vis <= 100)) throw new Error("Visibility must be between 1 and 100 ft");
    if (reportsLeftToday() <= 0) throw new Error("That's the limit of 4 reports for today");
    const rep = { lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100, vis: Math.round(vis),
                  temp: temp >= 40 && temp <= 85 ? Math.round(temp) : null, act: ["dive", "snorkel", "surface"].includes(act) ? act : "",
                  t: new Date().toISOString().slice(0, 16) + "Z", m: m > 0 ? Math.round(m) : null };
    const mine = LS.get("myreports", []); mine.push(rep); LS.set("myreports", mine.slice(-50));
    const c = LS.get("rcount", {}); c[todayKey()] = (c[todayKey()] || 0) + 1; LS.set("rcount", { [todayKey()]: c[todayKey()] });
    const q = LS.get("queue", []); q.push(rep); LS.set("queue", q);
    await flushQueue();
    return rep;
  }
  async function flushQueue() {
    const cfg = st.cfg;
    if (!cfg?.form_action || !navigator.onLine) return;
    let q = LS.get("queue", []);
    const left = [];
    for (const r of q) {
      const body = new URLSearchParams();
      const e = cfg.entries;
      body.set(e.lat, r.lat); body.set(e.lon, r.lon); body.set(e.visibility_ft, r.vis);
      if (r.temp != null) body.set(e.water_temp_f, r.temp);
      if (r.act) body.set(e.activity, r.act);
      body.set(e.observed_at, r.t);
      if (r.m != null && e.model_ft) body.set(e.model_ft, r.m);
      try { await fetch(cfg.form_action, { method: "POST", mode: "no-cors", body }); } catch { left.push(r); }
    }
    LS.set("queue", left);
  }
  window.addEventListener("online", flushQueue);

  return { init, estimate, outlook, tideAt, spots, saveSpot, removeSpot, submitReport, reportsLeftToday, LABEL, rating, ready: () => !!st.cond, configured: () => !!st.cfg?.form_action };
})();
