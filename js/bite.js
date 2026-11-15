/* "Bite conditions": a per-species score built from rules of thumb about tide, swell, wind, light, season and
   recent weather. It is NOT a catch prediction; nothing here has been checked against catch data yet. */
const Bite = (() => {
  const H3 = 3 * 3600e3;
  const LS = { get(k, d) { try { return JSON.parse(localStorage.getItem("lc_" + k)) ?? d; } catch { return d; } },
               set(k, v) { try { localStorage.setItem("lc_" + k, JSON.stringify(v)); } catch { } } };
  const SPECIES = [
    { id: "rockfish", name: "Rockfish", how: "boat or kayak" },
    { id: "lingcod", name: "Lingcod", how: "boat or kayak" },
    { id: "halibut", name: "California halibut", how: "shore or kayak" },
    { id: "surfperch", name: "Surfperch", how: "from the beach" },
    { id: "crab", name: "Crab", how: "hoop nets or snares" },
  ];
  // Rough yearly cycle, Jan..Dec (1 = peak). Lingcod move shallow and aggressive around winter spawning;
  // halibut come shallow in spring and summer; barred surfperch are best from late fall through spring.
  const SEASON = {
    lingcod: [.9, .9, .85, .75, .7, .7, .7, .8, .9, 1, 1, 1],
    halibut: [.45, .45, .6, .8, 1, 1, 1, .9, .8, .6, .5, .45],
    surfperch: [1, 1, 1, 1, .85, .8, .8, .8, .8, .85, 1, 1],
  };
  const SEASON_TXT = {
    lingcod: ["peak season: lingcod are shallow and aggressive around spawning", "off-peak time of year for lingcod"],
    halibut: ["peak season: halibut are in shallow water", "off season: most halibut are deeper this time of year"],
    surfperch: ["good time of year for surfperch", "slower time of year for surfperch"],
  };
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hour12: false, weekday: "short", month: "numeric", day: "numeric", year: "numeric" });
  function la(t) { const o = {}; for (const p of fmt.formatToParts(new Date(t))) o[p.type] = p.value;
    return { hour: +o.hour % 24, dow: o.weekday, month: +o.month, key: `${o.year}-${o.month}-${o.day}` }; }
  const hr = h => { h = ((h % 24) + 24) % 24; return (h % 12 || 12) + (h < 12 ? "a" : "p"); };
  const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;

  function grunionNight(t, lat) {         // runs follow full and new moons, March to August, mostly south of Monterey
    const m = la(t).month; if (m < 3 || m > 8 || lat > 36.7 || !window.SunCalc) return false;
    const p = SunCalc.getMoonIllumination(new Date(t)).phase;
    const d = Math.min(p * 29.53, ((p + 0.5) % 1) * 29.53);
    return d >= 1 && d <= 4.5;
  }

  function environment(lon, lat) {
    const S = Vis.series(lon, lat), tide = Vis.tideTimeline(lon, lat);
    if (!S || !S.length) return null;
    const now = Date.now(), visByDay = {};
    const AL = typeof alertsAt === "function" ? alertsAt(lat, lon) : [];
    const SURF = /High Surf|Beach Hazards|Rip Current|Coastal Flood|Tsunami/, SEA = /Small Craft|Gale Warning|Storm Warning|Hazardous Seas Warning|Hurricane Force|Special Marine|Tsunami/;
    const worst = list => list.sort((a, b) => /Warning/.test(b.event) - /Warning/.test(a.event))[0] || null;
    return S.map((s, i) => {
      const mid = s.t + H3 / 2, L = la(s.t);
      const e = { ...s, i, mid, L };
      if (tide) {
        e.lvl = tide.level(mid);
        const a = tide.level(mid - 1800e3), b = tide.level(mid + 1800e3);
        e.rate = a != null && b != null ? b - a : null;                 // ft per hour
        const r = tide.range(mid); e.range = r && r.range; e.high = !!(r && e.lvl != null && e.lvl > r.mid);
      }
      if (window.SunCalc) {
        const st = SunCalc.getTimes(new Date(mid), lat, lon), sr = +st.sunrise, ss = +st.sunset;
        e.day = s.t + H3 > sr - 1800e3 && s.t < ss + 1800e3;
        e.dawn = Math.abs(mid - sr) < 1.75 * 3600e3; e.dusk = Math.abs(mid - ss) < 1.75 * 3600e3;
      } else e.day = L.hour >= 6 && L.hour < 18;
      // the past 3 days, for upwelling and "rested reef" effects
      const nwOf = p => p.wdir >= 280 && p.wdir <= 350 ? p.wind : 0;
      const past = S.slice(Math.max(0, i - 24), i);
      const nw = avg(past.filter(p => p.wind != null).map(nwOf));
      const maxSst = Math.max(-99, ...past.map(p => p.sst ?? -99));
      e.cold = (nw != null && nw >= 14) || (s.sst != null && maxSst > -99 && s.sst - maxSst <= -1.5);
      const early = avg(S.slice(Math.max(0, i - 24), Math.max(0, i - 8)).filter(p => p.wind != null).map(nwOf));
      const lately = S.slice(Math.max(0, i - 4), i + 1).map(p => p.wind ?? 0);
      e.relaxed = early != null && early >= 14 && Math.max(...lately) < 8;
      const rough = p => (p.hn != null && p.hn >= 2.5) || (p.wind != null && p.wind >= 20);
      const before = S.slice(Math.max(0, i - 16), Math.max(0, i - 3));
      e.rested = before.length >= 6 && before.filter(rough).length / before.length >= 0.5 && !rough(s);
      const d = Math.max(0, Math.min(2, Math.floor((s.t - now) / 864e5 + 0.5)));
      if (!(d in visByDay)) visByDay[d] = Vis.estimate(lon, lat, d)?.ft ?? null;
      e.vis = visByDay[d];
      e.grunion = !!e.dusk && grunionNight(mid, lat);
      const active = AL.filter(a => (!a.onset || +new Date(a.onset) < s.t + H3) && (!a.ends || +new Date(a.ends) > s.t));
      e.surfWarn = worst(active.filter(a => SURF.test(a.event)));
      e.seaWarn = worst(active.filter(a => SEA.test(a.event)));
      return e;
    });
  }

  // Each rule multiplies the score and may leave a reason. Base 70 = an ordinary fishable day.
  function score(id, e) {
    let p = 1; const why = [];
    const add = (m, text, show) => { p *= m; if (text && (m !== 1 || show)) why.push({ up: m >= 1, w: Math.abs(Math.log(m)) + (show ? 0.01 : 0), text }); };
    const boat = id === "rockfish" || id === "lingcod";
    const h = e.hn, w = e.wind, rate = e.rate == null ? null : Math.abs(e.rate);
    // Safety first: an active National Weather Service warning overrides everything else.
    const shore = id === "surfperch" || id === "halibut" || id === "crab";
    if (shore && e.surfWarn) add(/Warning/.test(e.surfWarn.event) ? .3 : .45, `${e.surfWarn.event} in effect: dangerous on beaches, rocks and jetties`);
    if (id !== "surfperch" && e.seaWarn) add(/Small Craft/.test(e.seaWarn.event) ? .45 : .25, `${e.seaWarn.event} in effect: unsafe for small boats and kayaks`);
    // Very large swell offshore means surges and sneaker waves even where the coast gives some shelter.
    if (shore && e.h != null && e.h >= 2.4) add(e.h >= 3.5 ? .5 : .7, `${Math.round(e.h * 3.28084)} ft swell offshore: surges and sneaker waves even in sheltered spots`);
    if (boat) {
      if (h != null) add(h < 1.2 ? 1 : h < 2 ? .8 : h < 2.8 ? .5 : .2, h < 1.2 ? "small swell at this spot" : h < 2 ? "moderate swell makes it harder to fish" : "big swell: rough and hard to hold bottom", h < 1.2);
      if (h != null && h >= 1.5 && e.per != null && e.per < 8) add(.85, "short, steep chop");
      if (w != null) add(w < 8 ? 1 : w < 12 ? .85 : w < 18 ? .6 : .3, w < 8 ? "light wind: slow, easy drift" : w < 12 ? "some wind: faster drift" : "windy: drifting too fast to stay near the bottom", w < 8);
      if (rate != null && rate > 1) add(.85, "strong tidal current");
      if (e.cold) add(.7, "cold upwelled water after days of northwest wind");
      if (e.relaxed) add(1.1, "wind has eased after a blow");
      if (e.rested) add(1.1, "reefs rested by recent rough weather");
      if ((e.L.dow === "Sat" || e.L.dow === "Sun") && e.L.hour >= 11) add(.95, "weekend pressure by midday");
      if (id === "lingcod") {
        const s = SEASON.lingcod[e.L.month - 1]; add(s, SEASON_TXT.lingcod[s >= .9 ? 0 : 1], s >= .9);
        if (rate != null && rate < 0.4) add(1.1, "near slack tide, when lingcod bite best");
        if (e.range != null && e.range > 6) add(.9, "big tide swing today");
        if (e.vis != null && e.vis < 6) add(.8, "murky water for a sight feeder");
      }
    } else if (id === "halibut") {
      const s = SEASON.halibut[e.L.month - 1]; add(s, SEASON_TXT.halibut[s >= .8 ? 0 : 1], s >= .8);
      if (e.rate != null) { const m = e.rate > 0.15 ? 1.15 : rate < 0.35 && e.high ? 1.1 : e.rate < -0.8 ? .85 : 1;
        add(m, m === 1.15 ? "incoming tide" : m === 1.1 ? "high slack tide" : "fast outgoing tide"); }
      if (e.range != null && e.range > 6) add(.85, "big tide swing today");
      if (e.sst != null && e.sst < 14) add(e.sst >= 12 ? .85 : .7, "cold water slows halibut");
      if (e.vis != null) add(e.vis >= 8 ? 1 : e.vis >= 5 ? .85 : .6, e.vis >= 8 ? "clear enough for halibut to hunt" : "murky water", e.vis >= 8);
      if (h != null) add(h < 1 ? 1 : h < 1.6 ? .85 : h < 2.3 ? .6 : .35, h < 1 ? "small surf" : h < 1.6 ? "moderate surf" : "heavy surf", h < 1);
      if (w != null && w >= 12) add(w < 18 ? .8 : .55, "windy");
      if (e.dawn || e.dusk) add(1.1, e.dawn ? "dawn light" : "dusk light");
      if (e.grunion) add(1.25, "grunion run expected tonight: halibut follow them into the surf");
    } else if (id === "surfperch") {
      const s = SEASON.surfperch[e.L.month - 1]; add(s, SEASON_TXT.surfperch[s >= .95 ? 0 : 1], s >= .95);
      if (e.rate != null) { const m = e.rate > 0.15 ? 1.15 : rate < 0.35 && e.high ? 1.1 : rate < 0.35 ? .8 : .95;
        add(m, m === 1.15 ? "incoming tide" : m === 1.1 ? "high slack tide" : m === .8 ? "low slack tide" : "outgoing tide"); }
      if (h != null) add(h < 0.4 ? .8 : h < 1.6 ? 1.1 : h < 2.4 ? .8 : .45, h < 0.4 ? "surf is flat: little churn to stir up food" : h < 1.6 ? "moderate surf churning up sand crabs" : h < 2.4 ? "heavy surf" : "surf is blown out");
      if (w != null && w >= 12) add(w < 18 ? .85 : .6, "windy");
      if (e.dawn || e.dusk) add(1.15, e.dawn ? "dawn light" : "dusk light");
    } else if (id === "crab") {
      if (rate != null) add(rate < 0.4 ? 1.15 : rate > 1 ? .75 : 1, rate < 0.4 ? "near slack tide: nets sit still and crab roam" : "strong current moves nets and scent");
      if (e.range != null) add(e.range > 6 ? .85 : e.range < 4 ? 1.05 : 1, e.range > 6 ? "big tide swing today" : "small tide swing today");
      if (h != null) add(h < 1.5 ? 1 : h < 2.2 ? .75 : .45, h < 1.5 ? "calm enough to work nets" : "swell makes nets hard to work", h < 1.5);
      if (w != null && w >= 12) add(w < 18 ? .8 : .55, "windy");
    }
    why.sort((a, b) => b.w - a.w);
    return { score: Math.max(0, Math.min(100, Math.round(70 * p))), why: why.slice(0, 6) };
  }
  const rating = s => s >= 65 ? "good" : s >= 40 ? "fair" : "poor";

  function forecast(lon, lat) {
    const E = environment(lon, lat);
    if (!E) return null;
    const now = Date.now(), today = la(now).key;
    const keys = [];
    for (const e of E) if (e.t + H3 > now && !keys.includes(e.L.key)) keys.push(e.L.key);
    const days = keys.slice(0, 3);
    const label = k => k === today ? "Today" : E.find(e => e.L.key === k).L.dow;
    const meta = days.map(k => { const st = E.filter(e => e.L.key === k && e.day && e.hn != null);
      return { swell: st.length ? avg(st.map(e => e.hn)) : null, wind: st.length ? Math.max(...st.map(e => e.wind ?? 0)) : null }; });
    return { days: days.map(label), meta, species: SPECIES.map(sp => {
      const ok = e => sp.id === "crab" ? e.L.hour >= 4 && e.L.hour < 22 : e.day;
      const nowE = E.find(e => now >= e.t && now < e.t + H3);
      const out = { ...sp, now: nowE && ok(nowE) ? score(sp.id, nowE) : null, days: [] };
      for (const k of days) {
        let best = null;
        for (const e of E) { if (e.L.key !== k || e.t + H3 <= now || !ok(e)) continue;
          const r = score(sp.id, e); if (!best || r.score > best.score) best = { ...r, win: `${hr(e.L.hour)}–${hr(e.L.hour + 3)}` }; }
        out.days.push(best ? { ...best, label: label(k), rating: rating(best.score) } : null);
      }
      return out; }) };
  }

  // Private catch log, kept on this phone, with the score at the time so the rules can be checked later.
  const logs = () => LS.get("bitelog", []);
  function addLog({ lat, lon, sp, bite, bait, score }) {
    const l = logs(); l.push({ t: new Date().toISOString().slice(0, 16) + "Z", lat: +lat.toFixed(2), lon: +lon.toFixed(2), sp, bite, bait: !!bait, score });
    LS.set("bitelog", l.slice(-300));
  }
  return { forecast, rating, SPECIES, logs, addLog };
})();
