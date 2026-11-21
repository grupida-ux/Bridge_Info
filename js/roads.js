// Straßennetz laden und dem aktuellen Straßenverlauf vorausfolgen
// (Modus ohne Ziel: Vorhersage des wahrscheinlichen Weges)
import { distance, bearing, angleDiff, makeProjector, segDist, Polyline } from './geo.js';
import { overpass, parseBridges, matchBridgesToRoute, parseTons, parseMeters } from './bridges.js';

const DRIVABLE = 'motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|road|busway';
const RANK = {
  motorway: 1, trunk: 2, primary: 3, secondary: 4, tertiary: 5, unclassified: 6,
  residential: 7, living_street: 8, road: 7, busway: 8,
};
const rank = (hw) => RANK[(hw || '').replace('_link', '')] ?? 7;
const CELL = 0.002;

/** Straßen und Brücken in einer Bounding-Box laden */
export async function fetchArea(bbox, signal) {
  const bb = `${bbox.s},${bbox.w},${bbox.n},${bbox.e}`;
  const q = `[out:json][timeout:60];(way["highway"~"^(${DRIVABLE})$"]["area"!="yes"](${bb});way["bridge"]["bridge"!="no"]["railway"](${bb});way["bridge"]["bridge"!="no"]["highway"](${bb}););out body geom qt;`;
  const json = await overpass(q, signal, { attempts: 4, timeoutMs: 70000 });
  const bridgeEls = json.elements.filter((e) => e.tags?.bridge && e.tags.bridge !== 'no');
  return {
    network: new RoadNetwork(json.elements, bbox),
    bridges: parseBridges({ elements: bridgeEls }),
  };
}

function onewayOf(t) {
  const o = t.oneway;
  if (o === 'yes' || o === 'true' || o === '1') return 1;
  if (o === '-1' || o === 'reverse') return -1;
  if (o === 'no') return 0;
  if (t.junction === 'roundabout' || t.junction === 'circular') return 1;
  if (t.highway === 'motorway' || t.highway === 'motorway_link') return 1;
  return 0;
}

export class RoadNetwork {
  constructor(elements, bbox) {
    this.bbox = bbox;
    this.ways = [];
    this.nodeWays = new Map();
    this.grid = new Map();
    const re = new RegExp(`^(${DRIVABLE})$`);
    for (const el of elements) {
      if (el.type !== 'way' || !el.tags || !re.test(el.tags.highway || '')) continue;
      if (!el.geometry || !el.nodes || el.geometry.length < 2 || el.geometry.some((g) => !g)) continue;
      const t = el.tags;
      const w = {
        id: el.id,
        tags: t,
        nodes: el.nodes,
        geom: el.geometry.map((g) => ({ lat: g.lat, lon: g.lon })),
        oneway: onewayOf(t),
        bridge: !!t.bridge && t.bridge !== 'no',
        rank: rank(t.highway),
        link: /_link$/.test(t.highway),
        ref: t.ref || null,
        name: t.name || null,
      };
      const wi = this.ways.push(w) - 1;
      w.nodes.forEach((n, k) => {
        let arr = this.nodeWays.get(n);
        if (!arr) this.nodeWays.set(n, (arr = []));
        arr.push({ wi, k });
      });
      for (let i = 0; i < w.geom.length - 1; i++) {
        const a = w.geom[i], b = w.geom[i + 1];
        const r0 = Math.floor(Math.min(a.lat, b.lat) / CELL), r1 = Math.floor(Math.max(a.lat, b.lat) / CELL);
        const c0 = Math.floor(Math.min(a.lon, b.lon) / CELL), c1 = Math.floor(Math.max(a.lon, b.lon) / CELL);
        for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
          const key = r + ':' + c;
          let arr = this.grid.get(key);
          if (!arr) this.grid.set(key, (arr = []));
          arr.push(wi, i);
        }
      }
    }
  }

  contains(p, margin = 0) {
    const b = this.bbox;
    const dLat = margin / 111320, dLon = margin / (111320 * Math.cos((p.lat * Math.PI) / 180));
    return p.lat > b.s + dLat && p.lat < b.n - dLat && p.lon > b.w + dLon && p.lon < b.e - dLon;
  }

  /**
   * Position einer Straße zuordnen (Map-Matching). Berücksichtigt Abstand,
   * Fahrtrichtung, Einbahnstraßen und bevorzugt die bisher befahrene Straße.
   */
  match(pos, heading, prevWayId = null) {
    const proj = makeProjector(pos);
    const r = Math.floor(pos.lat / CELL), c = Math.floor(pos.lon / CELL);
    const seen = new Set();
    let best = null;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const arr = this.grid.get(r + dr + ':' + (c + dc));
      if (!arr) continue;
      for (let j = 0; j < arr.length; j += 2) {
        const wi = arr[j], i = arr[j + 1];
        const key = wi * 100000 + i;
        if (seen.has(key)) continue;
        seen.add(key);
        const w = this.ways[wi];
        const A = w.geom[i], B = w.geom[i + 1];
        const s = segDist({ x: 0, y: 0 }, proj.toXY(A), proj.toXY(B));
        if (s.d > 35) continue;
        const segBrg = bearing(A, B);
        for (const dir of [1, -1]) {
          if (w.oneway && dir !== w.oneway) continue;
          const travel = dir > 0 ? segBrg : (segBrg + 180) % 360;
          const ang = Math.abs(angleDiff(heading, travel));
          if (ang > 50) continue;
          const score = s.d + ang * 0.6 - (w.id === prevWayId ? 12 : 0);
          if (!best || score < best.score) {
            best = { score, wi, i, dir, dist: s.d, point: proj.toLL({ x: s.x, y: s.y }) };
          }
        }
      }
    }
    return best;
  }

  /** Nächste Straße an einem Knoten wählen: gleiche Nummer/Name, gleiche Klasse, möglichst geradeaus */
  _next(fromWi, nodeId, inBearing) {
    const from = this.ways[fromWi];
    const opts = this.nodeWays.get(nodeId) || [];
    let best = null;
    for (const { wi, k } of opts) {
      if (wi === fromWi) continue;
      const w = this.ways[wi];
      for (const dir of [1, -1]) {
        const k2 = k + dir;
        if (k2 < 0 || k2 >= w.geom.length) continue;
        if (w.oneway && dir !== w.oneway) continue;
        const out = bearing(w.geom[k], w.geom[k2]);
        const turn = Math.abs(angleDiff(inBearing, out));
        if (turn > 110) continue;
        let score = turn;
        if (from.ref && w.ref && sharesRef(from.ref, w.ref)) score -= 70;
        else if (from.name && w.name === from.name) score -= 50;
        score += Math.abs(w.rank - from.rank) * 12;
        if (w.link && !from.link) score += 35; // Abfahrten nicht bevorzugen
        if (!best || score < best.score) best = { score, wi, k, dir };
      }
    }
    return best;
  }

  /**
   * Ab der zugeordneten Position der Straße folgen.
   * Liefert den vorhergesagten Weg und die darauf liegenden Brückenabschnitte.
   */
  follow(m, lookahead) {
    const points = [m.point];
    const spans = []; // Brückenabschnitte {from, to, wayIds}
    let along = 0;
    let wi = m.wi, dir = m.dir;
    let idx = dir > 0 ? m.i + 1 : m.i;
    let cur = m.point;
    const visits = new Map();
    const hardLimit = lookahead + 3000;
    let steps = 0;
    outer: while (steps++ < 5000) {
      const w = this.ways[wi];
      while (idx >= 0 && idx < w.geom.length) {
        const p = w.geom[idx];
        const d = distance(cur, p);
        if (w.bridge) {
          const last = spans[spans.length - 1];
          if (last && Math.abs(last.to - along) < 1) { last.to = along + d; if (!last.wayIds.includes(w.id)) last.wayIds.push(w.id); }
          else spans.push({ from: along, to: along + d, wayIds: [w.id], start: cur });
        }
        along += d;
        points.push(p);
        cur = p;
        // Am Horizont stoppen – eine angefangene Brücke aber zu Ende verfolgen
        if ((along >= lookahead && !w.bridge) || along >= hardLimit) break outer;
        idx += dir;
      }
      const endNode = w.nodes[dir > 0 ? w.nodes.length - 1 : 0];
      const n = w.geom.length;
      const inBrg = dir > 0 ? bearing(w.geom[n - 2], w.geom[n - 1]) : bearing(w.geom[1], w.geom[0]);
      const nx = this._next(wi, endNode, inBrg);
      if (!nx) break;
      const v = (visits.get(nx.wi) || 0) + 1;
      if (v > 2) break; // Schleife (z. B. Kreisverkehr)
      visits.set(nx.wi, v);
      wi = nx.wi;
      dir = nx.dir;
      idx = nx.k + dir;
    }
    return { points, length: along, spans, wayId: this.ways[m.wi].id };
  }
}

function sharesRef(a, b) {
  const A = a.split(/\s*;\s*/), B = new Set(b.split(/\s*;\s*/));
  return A.some((x) => B.has(x));
}

/**
 * Vorhersage + Brücken darauf. `bridges` ist die Brückensammlung (für Namen,
 * Geometrie und Unterführungen). Rückgabe im selben Format wie Routen-Treffer.
 */
export function predictBridges(network, bridges, pos, heading, lookahead, prevWayId, withUnder) {
  const m = network.match(pos, heading, prevWayId);
  if (!m) return null;
  const pred = network.follow(m, lookahead);
  const items = [];
  for (const s of pred.spans) {
    const bs = s.wayIds.map((id) => bridges.get(id)).filter(Boolean);
    if (!bs.length) continue;
    const named = bs.find((b) => b.named);
    const tags = bs.map((b) => b.tags);
    items.push({
      key: 'p' + s.wayIds[0],
      bridge: bs[0],
      bridges: bs,
      name: (named || bs[0]).name,
      type: 'over',
      along: s.from,
      alongEnd: s.to,
      distance: s.from,
      onIt: s.from < 1,
      partial: s.from < 1, // Länge = Rest bis zum Brückenende
      length: s.to - s.from,
      height: maxOf(bs.map((b) => b.height)),
      maxweight: minOf(tags.map((t) => parseTons(t.maxweight))),
      maxheight: null,
      point: s.start,
    });
  }
  // Unterführungen: Brücken, die den vorhergesagten Weg kreuzen
  if (withUnder && pred.points.length > 1) {
    const line = new Polyline(pred.points);
    const own = new Set(pred.spans.flatMap((s) => s.wayIds));
    const near = new Map();
    for (const [id, b] of bridges) {
      if (own.has(id)) continue;
      if (pred.points.some((p, i) => i % 5 === 0 && distance(p, b.geom[0]) < 600 + b.length)) near.set(id, b);
    }
    for (const h of matchBridgesToRoute(near, line)) {
      if (h.type !== 'under' || h.along <= 0) continue;
      items.push({ ...h, key: 'pu' + h.bridge.id, distance: h.along, onIt: false, maxheight: h.maxheight ?? parseMeters(h.bridge.tags.maxheight) });
    }
  }
  items.sort((a, b) => a.distance - b.distance);
  return { ...pred, items, matchDist: m.dist };
}

function maxOf(arr) { const v = arr.filter((x) => x != null); return v.length ? Math.max(...v) : null; }
function minOf(arr) { const v = arr.filter((x) => x != null); return v.length ? Math.min(...v) : null; }
