/* Rough underwater visibility estimate, tides, saved spots and public diver reports. */
const Vis = (() => {
  const FT = 3.28084, H3 = 3 * 3600e3;
  const st = { cond: null, tides: null, cfg: null, predictors: {} };
  const km = (aLon, aLat, bLon, bLat) => Math.hypot((aLon - bLon) * 111.32 * Math.cos(aLat * Math.PI / 180), (aLat - bLat) * 110.57);
  const LS = { get(k, d) { try { return JSON.parse(localStorage.getItem("lc_" + k)) ?? d; } catch { return d; } },
               set(k, v) { try { localStorage.setItem("lc_" + k, JSON.stringify(v)); } catch { } } };

  function init(cond, tides, cfg) { st.cond = cond; st.tides = tides; st.cfg = cfg; flushQueue(); }

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

  function estimate(lon, lat, dayOffset = 0) {
    const C = st.cond;
    if (!C) return null;
    const why = [];
    let conf = 2;
    const pt = nearest(C.points, lon, lat, p => [p.lon, p.lat], 20);
    const sat = nearest(C.sat, lon, lat, c => [c[0], c[1]], 6);
    let base;
    if (sat) {
      const [, , kd, age] = sat.it;
      base = Math.max(3, Math.min(100, (1.5 / kd) * FT));
      if (age <= 1.5 && sat.d <= 4) { conf += 1; why.push(`satellite clarity from ${age < 1 ? "today" : "yesterday"}`); }
      else if (age > 3) { conf -= 1; why.push(`satellite reading is ${Math.round(age)} days old (fog?)`); }
      else why.push(`satellite clarity from ${Math.round(age)} days ago`);
    } else { base = 12; conf -= 1; why.push("no recent satellite reading nearby (fog or too close to shore)"); }

    let h = null, wind = null, sst = null, t0 = null, idx = 0;
    if (pt) {
      const p = pt.it; t0 = new Date(p.t0 + "Z");
      if (dayOffset === 0) {
        idx = Math.max(0, Math.min((p.wh || []).length - 1, Math.floor((Date.now() - t0) / H3)));
        h = p.wh?.[idx]; wind = p.ws?.[idx]; sst = p.sst?.[idx];
      } else {
        const from = Math.max(0, Math.floor((Date.now() - t0) / H3) + dayOffset * 8 - 2), to = from + 8;
        const sl = a => (a || []).slice(from, to).filter(v => v != null);
        h = sl(p.wh).length ? Math.max(...sl(p.wh)) : null; wind = sl(p.ws).length ? Math.max(...sl(p.ws)) : null;
        sst = sl(p.sst)[0] ?? null;
      }
    }
    let est = base * swellFactor(h) * windFactor(wind);
    if (h != null && h >= 2) why.push(`${(h * FT).toFixed(0)} ft swell stirring things up`);
    else if (h != null) why.push(`small swell (${(h * FT).toFixed(0)} ft)`);
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
             rating: rating(est), conf: conf <= 1 ? "low" : conf === 2 ? "medium" : "high", why, swell: h, period: pt?.it.wp?.[idx],
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
  async function submitReport({ lat, lon, vis, temp, act }) {
    if (!(vis >= 1 && vis <= 100)) throw new Error("Visibility must be between 1 and 100 ft");
    if (reportsLeftToday() <= 0) throw new Error("That's the limit of 4 reports for today");
    const rep = { lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100, vis: Math.round(vis),
                  temp: temp >= 40 && temp <= 85 ? Math.round(temp) : null, act: ["dive", "snorkel", "surface"].includes(act) ? act : "",
                  t: new Date().toISOString().slice(0, 16) + "Z" };
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
      try { await fetch(cfg.form_action, { method: "POST", mode: "no-cors", body }); } catch { left.push(r); }
    }
    LS.set("queue", left);
  }
  window.addEventListener("online", flushQueue);

  return { init, estimate, outlook, tideAt, spots, saveSpot, removeSpot, submitReport, reportsLeftToday, LABEL, rating, ready: () => !!st.cond, configured: () => !!st.cfg?.form_action };
})();
