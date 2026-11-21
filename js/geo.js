// Geometrie-Hilfsfunktionen (WGS84, Kugelnäherung)
export const EARTH_R = 6371008.8;
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

/** Großkreis-Distanz in Metern */
export function distance(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Kurs von a nach b in Grad (0 = Nord, im Uhrzeigersinn) */
export function bearing(a, b) {
  const φ1 = toRad(a.lat), φ2 = toRad(b.lat), Δλ = toRad(b.lon - a.lon);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Vorzeichenbehaftete Winkeldifferenz b - a im Bereich (-180, 180] */
export function angleDiff(a, b) {
  return ((((b - a) % 360) + 540) % 360) - 180;
}

/** Winkel zwischen zwei Achsen (richtungsunabhängig), 0..90 */
export function axisDiff(a, b) {
  const d = Math.abs(angleDiff(a, b)) % 180;
  return Math.min(d, 180 - d);
}

/** Lokale ebene Projektion (Meter) um einen Referenzpunkt */
export function makeProjector(ref) {
  const ky = (EARTH_R * Math.PI) / 180;
  const kx = ky * Math.cos(toRad(ref.lat));
  return {
    toXY: (p) => ({ x: (p.lon - ref.lon) * kx, y: (p.lat - ref.lat) * ky }),
    toLL: (q) => ({ lat: ref.lat + q.y / ky, lon: ref.lon + q.x / kx }),
  };
}

/** Punkt in Richtung `brg` im Abstand `dist` */
export function destination(p, brg, dist) {
  const δ = dist / EARTH_R, θ = toRad(brg), φ1 = toRad(p.lat), λ1 = toRad(p.lon);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: toDeg(φ2), lon: ((toDeg(λ2) + 540) % 360) - 180 };
}

/** Linie so verdichten, dass kein Abschnitt länger als `step` Meter ist */
export function densify(points, step) {
  if (points.length < 2) return points.slice();
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const n = Math.ceil(distance(a, b) / step);
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      out.push({ lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t, seg: i - 1 });
    }
  }
  out[0] = { ...out[0], seg: 0 };
  return out;
}

/** Douglas-Peucker-Vereinfachung, Toleranz in Metern */
export function simplify(points, tol) {
  if (points.length < 3) return points.slice();
  const proj = makeProjector(points[Math.floor(points.length / 2)]);
  const xy = points.map(proj.toXY);
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = -1, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = segDist(xy[i], xy[s], xy[e]).d;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return points.filter((_, i) => keep[i]);
}

/** Abstand Punkt p zu Strecke a-b (ebene Koordinaten) */
export function segDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L2 = dx * dx + dy * dy;
  let t = L2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = a.x + t * dx, y = a.y + t * dy;
  return { t, x, y, d: Math.hypot(p.x - x, p.y - y) };
}

/**
 * Polylinie (z. B. Route) mit kumulierten Längen, Gitter-Index und
 * Map-Matching (nächster Punkt auf der Linie).
 */
export class Polyline {
  constructor(points) {
    this.pts = points;
    this.cum = new Float64Array(points.length);
    for (let i = 1; i < points.length; i++) this.cum[i] = this.cum[i - 1] + distance(points[i - 1], points[i]);
    this.length = this.cum[points.length - 1] || 0;
    this.cell = 0.002; // ~220 m in Breite
    this.grid = new Map();
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i], b = points[i + 1];
      const r0 = Math.floor(Math.min(a.lat, b.lat) / this.cell), r1 = Math.floor(Math.max(a.lat, b.lat) / this.cell);
      const c0 = Math.floor(Math.min(a.lon, b.lon) / this.cell), c1 = Math.floor(Math.max(a.lon, b.lon) / this.cell);
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
        const k = r + ':' + c;
        let arr = this.grid.get(k);
        if (!arr) this.grid.set(k, (arr = []));
        arr.push(i);
      }
    }
  }

  _segCandidates(p) {
    const r = Math.floor(p.lat / this.cell), c = Math.floor(p.lon / this.cell);
    const set = new Set();
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const arr = this.grid.get(r + dr + ':' + (c + dc));
      if (arr) for (const i of arr) set.add(i);
    }
    return set;
  }

  _project(p, i) {
    const proj = makeProjector(p);
    const a = proj.toXY(this.pts[i]), b = proj.toXY(this.pts[i + 1]);
    const r = segDist({ x: 0, y: 0 }, a, b);
    const segLen = this.cum[i + 1] - this.cum[i];
    return { index: i, t: r.t, dist: r.d, along: this.cum[i] + r.t * segLen, point: proj.toLL({ x: r.x, y: r.y }) };
  }

  /**
   * Nächster Punkt auf der Linie. Mit `hint` (letzter Segmentindex) wird
   * bevorzugt in Fahrtrichtung gesucht, damit Kreuzungen der Route mit sich
   * selbst nicht zu Sprüngen führen.
   */
  locate(p, hint = null) {
    let best = null;
    const consider = (i) => {
      if (i < 0 || i >= this.pts.length - 1) return;
      const r = this._project(p, i);
      if (!best || r.dist < best.dist) best = r;
    };
    if (hint != null) {
      for (let i = Math.max(0, hint - 5); i < Math.min(this.pts.length - 1, hint + 400); i++) consider(i);
      if (best && best.dist < 40) return best;
    }
    for (const i of this._segCandidates(p)) consider(i);
    if (!best) for (let i = 0; i < this.pts.length - 1; i++) consider(i);
    return best;
  }

  /** Nur Segmente aus dem Gitter-Index (schnell, ggf. null) */
  locateNear(p) {
    let best = null;
    for (const i of this._segCandidates(p)) {
      const r = this._project(p, i);
      if (!best || r.dist < best.dist) best = r;
    }
    return best;
  }

  bearingAt(index) {
    const i = Math.max(0, Math.min(this.pts.length - 2, index));
    return bearing(this.pts[i], this.pts[i + 1]);
  }

  /** Punkt bei Streckenmeter `along` */
  pointAt(along) {
    if (along <= 0) return { ...this.pts[0], index: 0 };
    if (along >= this.length) return { ...this.pts[this.pts.length - 1], index: this.pts.length - 2 };
    let lo = 0, hi = this.pts.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (this.cum[m] <= along) lo = m; else hi = m; }
    const segLen = this.cum[hi] - this.cum[lo];
    const t = segLen > 0 ? (along - this.cum[lo]) / segLen : 0;
    const a = this.pts[lo], b = this.pts[hi];
    return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t, index: lo };
  }
}
