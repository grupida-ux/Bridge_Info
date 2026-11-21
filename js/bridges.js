// Brückendaten aus OpenStreetMap (Overpass API) laden und auswerten
import { distance, bearing, axisDiff, densify, simplify, makeProjector } from './geo.js';

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const MOTOR_HIGHWAYS = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
  'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified',
  'residential', 'living_street', 'service', 'road', 'track', 'busway',
]);
const DEAD = /^(proposed|construction|abandoned|razed|disused|planned|demolished)$/;

const BRIDGE_FILTER = '["bridge"]["bridge"!="no"]';

async function overpass(query, signal) {
  let lastErr;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal,
      });
      if (!res.ok) throw new Error(`Overpass ${res.status}`);
      return await res.json();
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      lastErr = e;
    }
  }
  throw lastErr || new Error('Overpass nicht erreichbar');
}

/** Maße wie "3.8", "3,8 m", "12'6\"" in Meter umrechnen */
export function parseMeters(v) {
  if (!v) return null;
  const s = String(v).trim().toLowerCase();
  if (/^(none|default|unsigned|no)$/.test(s)) return null;
  const ft = s.match(/^(\d+(?:\.\d+)?)\s*'\s*(?:(\d+(?:\.\d+)?)\s*")?$/);
  if (ft) return +ft[1] * 0.3048 + (ft[2] ? +ft[2] * 0.0254 : 0);
  const m = s.replace(',', '.').match(/^(\d+(?:\.\d+)?)\s*(m)?$/);
  return m ? +m[1] : null;
}

/** Gewicht in Tonnen */
export function parseTons(v) {
  if (!v) return null;
  const m = String(v).trim().toLowerCase().replace(',', '.').match(/^(\d+(?:\.\d+)?)\s*(t)?$/);
  return m ? +m[1] : null;
}

function kindOf(tags) {
  if (tags.railway) return 'rail';
  if (MOTOR_HIGHWAYS.has(tags.highway)) return 'road';
  return 'path';
}

const KIND_LABEL = { road: 'Straßenbrücke', rail: 'Eisenbahnbrücke', path: 'Fuß-/Radwegbrücke' };

export function bridgeName(b) {
  const t = b.tags;
  return t['bridge:name'] || t.name || (t.ref ? `${KIND_LABEL[b.kind]} ${t.ref}` : KIND_LABEL[b.kind]);
}

/** Overpass-JSON → Brückenobjekte */
export function parseBridges(json) {
  const out = new Map();
  for (const el of json.elements || []) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    const tags = el.tags || {};
    if (!tags.highway && !tags.railway) continue;
    if (DEAD.test(tags.highway || '') || DEAD.test(tags.railway || '')) continue;
    const geom = el.geometry.map((g) => ({ lat: g.lat, lon: g.lon }));
    const b = {
      id: el.id,
      tags,
      kind: kindOf(tags),
      geom,
      dense: densify(geom, 8),
      maxheight: parseMeters(tags.maxheight || tags['maxheight:physical']),
      maxweight: parseTons(tags.maxweight),
      length: geom.slice(1).reduce((s, p, i) => s + distance(geom[i], p), 0),
    };
    b.name = bridgeName(b);
    b.named = !!(tags['bridge:name'] || tags.name);
    out.set(el.id, b);
  }
  return out;
}

/** Alle Brücken in einer Bounding-Box */
export async function fetchBridgesBBox(s, w, n, e, signal) {
  const bb = `${s},${w},${n},${e}`;
  const q = `[out:json][timeout:25];(way${BRIDGE_FILTER}["highway"](${bb});way${BRIDGE_FILTER}["railway"](${bb}););out tags geom;`;
  return parseBridges(await overpass(q, signal));
}

/** Alle Brücken entlang einer Linie (Route) – in Abschnitten abgefragt */
export async function fetchBridgesAlongLine(points, radius = 30, signal, onProgress) {
  const simple = simplify(points, 10);
  const CHUNK = 120;
  const all = new Map();
  const chunks = [];
  for (let i = 0; i < simple.length - 1; i += CHUNK - 1) chunks.push(simple.slice(i, i + CHUNK));
  for (let k = 0; k < chunks.length; k++) {
    const coords = chunks[k].map((p) => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`).join(',');
    const q = `[out:json][timeout:60];(way${BRIDGE_FILTER}["highway"](around:${radius},${coords});way${BRIDGE_FILTER}["railway"](around:${radius},${coords}););out tags geom;`;
    const res = parseBridges(await overpass(q, signal));
    for (const [id, b] of res) all.set(id, b);
    onProgress?.(k + 1, chunks.length);
  }
  return all;
}

/**
 * Typ bestimmen: verläuft die Brücke parallel zur eigenen Fahrtrichtung,
 * fährt man (vermutlich) darüber; kreuzt sie, fährt man darunter durch.
 * Liefert null, wenn die Brücke nicht relevant ist (paralleler Fußweg).
 */
function classify(b, segIdx, travelBearing) {
  const g = b.geom;
  const i = Math.max(0, Math.min(g.length - 2, segIdx ?? 0));
  const ang = axisDiff(bearing(g[i], g[i + 1]), travelBearing);
  if (ang < 30) return b.kind === 'road' ? 'over' : null;
  return 'under';
}

/**
 * Freie Fahrt (ohne Route): Brücken in einem Sichtkegel in Fahrtrichtung.
 * Gibt die nach Distanz sortierten Kandidaten zurück.
 */
export function bridgesAhead(bridges, pos, heading, lookahead) {
  const proj = makeProjector(pos);
  const h = (heading * Math.PI) / 180;
  const fx = Math.sin(h), fy = Math.cos(h); // Einheitsvektor Fahrtrichtung
  const res = [];
  for (const b of bridges.values()) {
    // Grober Vorfilter
    if (distance(pos, b.geom[0]) > lookahead + b.length + 50) continue;
    let best = null;
    for (const p of b.dense) {
      const q = proj.toXY(p);
      const f = q.x * fx + q.y * fy;      // Abstand nach vorn
      const l = q.x * fy - q.y * fx;      // seitlicher Abstand
      if (f < -15 || f > lookahead) continue;
      const tol = 14 + Math.max(0, f) * 0.1; // Kegel ≈ ±6°
      if (Math.abs(l) > tol) continue;
      if (!best || f < best.f) best = { f, l, p };
    }
    if (!best) continue;
    const type = classify(b, best.p.seg, heading);
    if (!type) continue;
    res.push({ bridge: b, distance: Math.max(0, best.f), point: best.p, type, onIt: best.f <= 0 });
  }
  res.sort((a, b) => a.distance - b.distance);
  return res;
}

/**
 * Route: Brücken auf die Route abbilden (Streckenmeter), nach Lage sortiert
 * und benachbarte Teilstücke (z. B. beide Richtungsfahrbahnen) zusammengefasst.
 */
export function matchBridgesToRoute(bridges, route, maxDist = 12) {
  const hits = [];
  for (const b of bridges.values()) {
    let first = null, last = null;
    for (const p of b.dense) {
      const m = route.locateNear(p);
      if (!m || m.dist > maxDist) continue;
      if (!first || m.along < first.m.along) first = { m, p };
      if (!last || m.along > last.m.along) last = { m, p };
    }
    if (!first) continue;
    const type = classify(b, first.p.seg, route.bearingAt(first.m.index));
    if (!type) continue;
    hits.push({
      bridge: b,
      bridges: [b],
      name: b.name,
      named: b.named,
      type,
      along: first.m.along,
      alongEnd: type === 'over' ? last.m.along : first.m.along,
      point: first.m.point,
      maxheight: b.maxheight,
      maxweight: b.maxweight,
    });
  }
  hits.sort((a, b) => a.along - b.along);
  // Zusammenfassen
  const merged = [];
  for (const h of hits) {
    const prev = merged[merged.length - 1];
    if (prev && prev.type === h.type && h.along <= prev.alongEnd + 40) {
      prev.bridges.push(h.bridge);
      prev.alongEnd = Math.max(prev.alongEnd, h.alongEnd);
      if (!prev.named && h.named) { prev.name = h.name; prev.named = true; }
      prev.maxheight = minDefined(prev.maxheight, h.maxheight);
      prev.maxweight = minDefined(prev.maxweight, h.maxweight);
    } else merged.push(h);
  }
  merged.forEach((h, i) => (h.key = 'r' + i + ':' + h.bridge.id));
  return merged;
}

function minDefined(a, b) {
  if (a == null) return b;
  if (b == null) return a;
  return Math.min(a, b);
}
