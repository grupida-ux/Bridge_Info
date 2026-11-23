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

/* ------------------------------------------------------------------
 * Kachel-Speicher für den Modus „Straße folgen“.
 *  - In Deutschland kommen Hauptstraßen und Brücken aus den vorab
 *    aufbereiteten Daten der eigenen Seite (staticData, ~11 × 10 km
 *    je Kachel) – schnell und ohne Abfragelimits.
 *  - Wohnstraßen (nur bei langsamer Fahrt nötig) und alles außerhalb
 *    Deutschlands kommen weiterhin von Overpass (~2,8 × 2,7 km je Kachel).
 * Kacheln bleiben erhalten und werden vorausschauend in Fahrtrichtung geholt.
 * ------------------------------------------------------------------ */
export const TILE_LAT = 0.025;
export const TILE_LON = 0.04;
const MAJOR = 'motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|road|busway';
const MINOR = 'residential|living_street';
const KEEP_TAGS = ['highway', 'railway', 'oneway', 'junction', 'ref', 'name', 'bridge', 'bridge:name', 'maxweight', 'maxheight', 'maxheight:physical', 'height', 'bridge:height', 'area'];
// Welche Overpass-Ebene deckt welche ab?
const SATISFIES = { all: ['all', 'major', 'minor'], major: ['major'], minor: ['minor'] };

export const tileOf = (p) => ({ r: Math.floor(p.lat / TILE_LAT), c: Math.floor(p.lon / TILE_LON) });
const tileKey = (t) => t.r + ':' + t.c;
const tileCenter = (t) => ({ lat: (t.r + 0.5) * TILE_LAT, lon: (t.c + 0.5) * TILE_LON });

async function fetchTile(t, level, signal) {
  const bb = `${t.r * TILE_LAT},${t.c * TILE_LON},${(t.r + 1) * TILE_LAT},${(t.c + 1) * TILE_LON}`;
  const classes = level === 'all' ? DRIVABLE : level === 'minor' ? MINOR : MAJOR;
  const bridges = level === 'minor' ? '' : `way["bridge"]["bridge"!="no"]["railway"](${bb});way["bridge"]["bridge"!="no"]["highway"](${bb});`;
  const q = `[out:json][timeout:50];(way["highway"~"^(${classes})$"]["area"!="yes"](${bb});${bridges});out body geom qt;`;
  const json = await overpass(q, signal, { attempts: 4, timeoutMs: 60000 });
  // nur benötigte Tags behalten (spart Speicher)
  for (const el of json.elements) {
    if (!el.tags) continue;
    const t2 = {};
    for (const k of KEEP_TAGS) if (el.tags[k] != null) t2[k] = el.tags[k];
    el.tags = t2;
  }
  return json.elements;
}

export class TileStore {
  /** @param staticData Instanz von StaticData (oder null) */
  constructor(staticData = null) {
    this.sd = staticData;
    this.tiles = new Map();   // Overpass: key -> { t, level, els }
    this.stat = new Map();    // vorab aufbereitet: key -> { key, els }
    this.failed = new Map();  // key -> Zeitpunkt des Fehlers
    this.loading = null;      // key der gerade geladenen Kachel
  }

  _covered(p) { return !!this.sd?.available && this.sd.covers(p); }

  _hasOverpass(p, level) {
    const e = this.tiles.get(tileKey(tileOf(p)));
    return !!e && SATISFIES[e.level].includes(level);
  }

  /** Sind für diesen Punkt Hauptstraßen vorhanden? */
  has(p) {
    if (this._covered(p)) return this.stat.has(this.sd.tileKey(p));
    return this._hasOverpass(p, 'major');
  }

  /**
   * Welche Kacheln werden gebraucht? Aktuelle Position, ein Fächer in
   * Fahrtrichtung (Vorausschau + ca. 1 Minute Fahrt) und das Ende des
   * vorhergesagten Weges. Nach Dringlichkeit sortiert.
   */
  needed(pos, heading, speed, look, predEnd, destinationFn) {
    speed = Math.min(Math.max(speed || 0, 0), 70);
    const slow = speed < 14; // < 50 km/h: auch Wohnstraßen laden
    const want = new Map();
    const put = (k, item) => {
      const prev = want.get(k);
      if (!prev || item.d < prev.d) want.set(k, item);
    };
    const add = (p, d, withMinor) => {
      if (distance(pos, p) > 10000) return; // Sicherheitsgrenze
      if (this._covered(p)) {
        const key = this.sd.tileKey(p);
        if (!this.stat.has(key)) put('S' + key, { src: 'static', key, k: 'S' + key, d });
        if (withMinor && !this._hasOverpass(p, 'minor')) {
          const t = tileOf(p), k = tileKey(t);
          put(k, { src: 'overpass', t, k, d: d + 300, level: 'minor' });
        }
      } else {
        const level = withMinor ? 'all' : 'major';
        if (this._hasOverpass(p, level)) return;
        const t = tileOf(p), k = tileKey(t);
        const prev = want.get(k);
        want.set(k, { src: 'overpass', t, k, d: Math.min(d, prev?.d ?? d), level: prev?.level === 'all' ? 'all' : level });
      }
    };
    add(pos, 0, slow);
    if (heading != null) {
      const D = look + Math.max(1500, speed * 60);
      for (let d = 400; d <= D; d += 400) {
        const minor = slow && d <= 1200;
        add(destinationFn(pos, heading, d), d, minor);
        if (d >= 800) {
          add(destinationFn(pos, heading - 25, d), d + 200, minor);
          add(destinationFn(pos, heading + 25, d), d + 200, minor);
        }
      }
    }
    if (predEnd) add(predEnd.point, predEnd.along, predEnd.minor);
    const now = Date.now();
    return [...want.values()]
      .filter((w) => now - (this.failed.get(w.k) || 0) > 12000)
      .sort((a, b) => a.d - b.d);
  }

  async load(w, signal) {
    this.loading = w.k;
    try {
      if (w.src === 'static') {
        const els = await this.sd.roadTile(w.key);
        this.stat.set(w.key, { key: w.key, els });
        this.failed.delete(w.k);
        return els;
      }
      const els = await fetchTile(w.t, w.level, signal);
      const prev = this.tiles.get(w.k);
      // vorhandene Ebene ergänzen (z. B. Hauptstraßen + später Wohnstraßen)
      const merged = prev ? prev.els.concat(els) : els;
      const level = prev && prev.level !== w.level ? 'all' : w.level;
      this.tiles.set(w.k, { t: w.t, level, els: merged });
      this.failed.delete(w.k);
      return els;
    } catch (e) {
      this.failed.set(w.k, Date.now());
      throw e;
    } finally {
      this.loading = null;
    }
  }

  /** Kacheln weit hinter dem Fahrzeug verwerfen (Speicher) */
  prune(pos, maxDist = 25000) {
    // maxDist muss deutlich größer sein als die Vorausladestrecke (max. ~7 km),
    // sonst würden gerade geladene Kacheln sofort wieder verworfen
    for (const [k, e] of this.tiles) if (distance(pos, tileCenter(e.t)) > maxDist) this.tiles.delete(k);
    for (const [k] of this.stat) if (distance(pos, this.sd.tileCenter(k)) > maxDist + 8000) this.stat.delete(k);
  }

  /** Straßennetz und Brücken aus allen Kacheln im Umkreis bauen */
  build(pos, radius = 15000) {
    const byId = new Map();
    for (const e of this.tiles.values()) {
      if (distance(pos, tileCenter(e.t)) > radius) continue;
      for (const el of e.els) byId.set(el.id, el);
    }
    for (const [k, e] of this.stat) {
      if (distance(pos, this.sd.tileCenter(k)) > radius + 8000) continue;
      for (const el of e.els) byId.set(el.id, el);
    }
    const els = [...byId.values()];
    return {
      network: new RoadNetwork(els),
      bridges: parseBridges({ elements: els.filter((e) => e.tags?.bridge && e.tags.bridge !== 'no') }),
    };
  }
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
  constructor(elements) {
    this.ways = [];
    this.nodeWays = new Map();
    this.grid = new Map();
    const re = new RegExp(`^(${DRIVABLE})$`);
    for (const el of elements) {
      if (el.type !== 'way' || !el.tags || !re.test(el.tags.highway || '')) continue;
      if (!el.geometry || el.geometry.length < 2 || el.geometry.some((g) => !g)) continue;
      const t = el.tags;
      const w = {
        id: el.id,
        tags: t,
        // Knoten über die Koordinate verknüpfen – funktioniert für Overpass-
        // und vorab aufbereitete Daten gleichermaßen (gemeinsame Knoten
        // haben in OSM exakt dieselbe Koordinate)
        nodes: el.geometry.map((g) => g.lat.toFixed(7) + ',' + g.lon.toFixed(7)),
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
    return { points, length: along, spans, wayId: this.ways[m.wi].id, endMinor: this.ways[wi].rank >= 7 };
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
