/* Geometry helpers. Coordinates are [lon, lat]; distances in meters (local flat projection, fine at these scales). */
const Geo = (() => {
  const R = 6371008.8, D = Math.PI / 180;
  const kx = lat => 111320 * Math.cos(lat * D);
  const KY = 110574;

  function ringContains(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function polys(geom) {
    if (!geom) return [];
    return geom.type === "Polygon" ? [geom.coordinates] : geom.type === "MultiPolygon" ? geom.coordinates : [];
  }
  function contains(geom, lon, lat) {
    for (const poly of polys(geom)) {
      if (!ringContains(lon, lat, poly[0])) continue;
      let hole = false;
      for (let h = 1; h < poly.length; h++) if (ringContains(lon, lat, poly[h])) { hole = true; break; }
      if (!hole) return true;
    }
    return false;
  }
  function segDist(lon, lat, a, b) {
    const k = kx(lat);
    const ax = (a[0] - lon) * k, ay = (a[1] - lat) * KY, bx = (b[0] - lon) * k, by = (b[1] - lat) * KY;
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    let t = L ? -(ax * dx + ay * dy) / L : 0;
    t = Math.max(0, Math.min(1, t));
    const px = ax + t * dx, py = ay + t * dy;
    return { d: Math.hypot(px, py), x: px, y: py };
  }
  // distance to nearest edge + bearing from point to that edge point
  function edgeDist(rings, lon, lat) {
    let best = { d: Infinity, x: 0, y: 0 };
    for (const ring of rings) for (let i = 1; i < ring.length; i++) {
      const s = segDist(lon, lat, ring[i - 1], ring[i]);
      if (s.d < best.d) best = s;
    }
    best.bearing = (Math.atan2(best.x, best.y) / D + 360) % 360;
    return best;
  }
  function geomRings(geom) {
    const out = [];
    for (const p of polys(geom)) for (const r of p) out.push(r);
    return out;
  }
  function bbox(geom) {
    let a = [Infinity, Infinity, -Infinity, -Infinity];
    for (const r of geomRings(geom)) for (const c of r) {
      if (c[0] < a[0]) a[0] = c[0]; if (c[1] < a[1]) a[1] = c[1];
      if (c[0] > a[2]) a[2] = c[0]; if (c[1] > a[3]) a[3] = c[1];
    }
    return a;
  }
  // Count crossings of an eastward ray (toward shore) with all parts of a depth line.
  // Odd = seaward of the line (the line sits between you and shore). Island rings add one
  // crossing when you're inside them, which correctly flips you back to "shoreward".
  function seaward(parts, lon, lat) {
    let n = 0;
    for (const p of parts) for (let i = 1; i < p.length; i++) {
      const [x1, y1] = p[i - 1], [x2, y2] = p[i];
      if ((y1 > lat) !== (y2 > lat)) {
        const x = x1 + (lat - y1) * (x2 - x1) / (y2 - y1);
        if (x > lon) n++;
      }
    }
    return n % 2 === 1;
  }
  function lineDist(parts, lon, lat) {
    let d = Infinity;
    for (const p of parts) {
      for (let i = 1; i < p.length; i++) d = Math.min(d, segDist(lon, lat, p[i - 1], p[i]).d);
    }
    return d;
  }
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const compass = b => dirs[Math.round(b / 45) % 8];
  function fmtDist(m) {
    const ft = m * 3.28084, mi = m / 1609.344;
    if (ft < 1000) return `${Math.round(ft / 10) * 10} ft`;
    return mi < 10 ? `${mi.toFixed(1)} mi` : `${Math.round(mi)} mi`;
  }
  return { contains, edgeDist, geomRings, bbox, seaward, lineDist, compass, fmtDist };
})();
