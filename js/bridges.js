// Brückendaten aus OpenStreetMap (Overpass API) laden und auswerten
import { distance, bearing, angleDiff, axisDiff, densify, simplify, makeProjector } from './geo.js';

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const MOTOR_HIGHWAYS = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
  'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified',
  'residential', 'living_street', 'service', 'road', 'track', 'busway',
]);
const DEAD = /^(proposed|construction|abandoned|razed|disused|planned|demolished)$/;

const BRIDGE_FILTER = '["bridge"]["bridge"!="no"]';

let preferred = 0; // zuletzt erfolgreicher Server

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(abortError()); }, { once: true });
});
function abortError() {
  const e = new Error('Abgebrochen');
  e.name = 'AbortError';
  return e;
}

/** Eine Abfrage an einen Server, mit eigenem Zeitlimit */
async function overpassOnce(url, query, signal, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, {
      method: 'POST',
      body: 'data=' + encodeURIComponent(query),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Overpass-Server antwortet mit ${res.status}`);
    const json = await res.json();
    // Bei Zeitüberschreitung o. Ä. liefert Overpass Status 200 mit leerer Liste und "remark"
    if (json.remark && /error|timed out|out of memory|abort/i.test(json.remark)) {
      throw new Error('Overpass: ' + json.remark);
    }
    if (!Array.isArray(json.elements)) throw new Error('Ungültige Overpass-Antwort');
    return json;
  } catch (e) {
    if (signal?.aborted) throw abortError();
    if (e.name === 'AbortError') throw new Error('Overpass-Zeitüberschreitung');
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Abfrage mit Wiederholung: wechselt bei Fehlern den Server und wartet
 * zunehmend länger (öffentliche Server sind oft überlastet).
 */
export async function overpass(query, signal, { attempts = 6, timeoutMs = 60000 } = {}) {
  let lastErr;
  for (let a = 0; a < attempts; a++) {
    const idx = (preferred + a) % OVERPASS_ENDPOINTS.length;
    try {
      const json = await overpassOnce(OVERPASS_ENDPOINTS[idx], query, signal, timeoutMs);
      preferred = idx;
      return json;
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      lastErr = e;
      console.warn(OVERPASS_ENDPOINTS[idx], e.message);
      if (a < attempts - 1 && a >= OVERPASS_ENDPOINTS.length - 1) await sleep(Math.min(2000 * 2 ** (a - OVERPASS_ENDPOINTS.length + 1), 15000), signal);
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
      height: parseMeters(tags['bridge:height'] || tags.height),
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

/**
 * Route in Abschnitte für die Overpass-Abfrage teilen
 * (je höchstens ~25 km bzw. 250 Stützpunkte).
 */
export function routeChunks(points, maxLen = 25000, maxPts = 250) {
  const simple = simplify(points, 10);
  const chunks = [];
  let cur = [simple[0]], len = 0;
  for (let i = 1; i < simple.length; i++) {
    cur.push(simple[i]);
    len += distance(simple[i - 1], simple[i]);
    if ((len >= maxLen || cur.length >= maxPts) && i < simple.length - 1) {
      chunks.push(cur);
      cur = [simple[i]];
      len = 0;
    }
  }
  if (cur.length > 1) chunks.push(cur);
  return chunks;
}

/** Brücken entlang eines Routenabschnitts */
export async function fetchBridgesAlongChunk(chunk, radius = 30, signal, opts = {}) {
  const coords = chunk.map((p) => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`).join(',');
  const q = `[out:json][timeout:90];(way${BRIDGE_FILTER}["highway"](around:${radius},${coords});way${BRIDGE_FILTER}["railway"](around:${radius},${coords}););out tags geom;`;
  return parseBridges(await overpass(q, signal, { timeoutMs: 100000, ...opts }));
}

/**
 * Alle Brücken entlang einer Route laden. Schlägt ein Abschnitt fehl, wird
 * mit den übrigen weitergemacht; die fehlgeschlagenen werden zurückgegeben,
 * damit sie später erneut versucht werden können.
 * onChunk(neueBrücken, fertig, gesamt) wird nach jedem Abschnitt aufgerufen.
 */
export async function fetchBridgesAlongLine(chunks, radius = 30, signal, onChunk) {
  const all = new Map();
  const failed = [];
  for (let k = 0; k < chunks.length; k++) {
    try {
      const res = await fetchBridgesAlongChunk(chunks[k], radius, signal);
      for (const [id, b] of res) all.set(id, b);
      onChunk?.(res, k + 1, chunks.length, failed.length);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      failed.push(k);
      onChunk?.(new Map(), k + 1, chunks.length, failed.length);
    }
  }
  return { bridges: all, failed };
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
      height: b.height,
      wayLength: b.groupLength ?? b.length,
    });
  }
  hits.sort((a, b) => a.along - b.along);
  // Zusammenfassen
  const merged = [];
  for (const h of hits) {
    // letzte Gruppe gleichen Typs suchen (Überfahrt/Unterführung können sich abwechseln)
    // (kurze Unterführungen mitten auf einer langen Brücke dürfen die Suche nicht abbrechen)
    let prev = null;
    for (let i = merged.length - 1; i >= 0 && merged[i].along >= h.along - 5000; i--) {
      if (merged[i].type === h.type && h.along <= merged[i].alongEnd + 40) { prev = merged[i]; break; }
    }
    if (prev && h.along <= prev.alongEnd + 40) {
      prev.bridges.push(h.bridge);
      prev.alongEnd = Math.max(prev.alongEnd, h.alongEnd);
      if (!prev.named && h.named) { prev.name = h.name; prev.named = true; }
      prev.maxheight = minDefined(prev.maxheight, h.maxheight);
      prev.maxweight = minDefined(prev.maxweight, h.maxweight);
      prev.height = maxDefined(prev.height, h.height);
      prev.wayLength = Math.max(prev.wayLength, h.wayLength);
    } else merged.push(h);
  }
  merged.forEach((h, i) => {
    h.key = 'r' + i + ':' + h.bridge.id;
    // Länge: bei Überfahrt die auf der Route zurückgelegte Strecke,
    // mindestens aber die Länge des zusammenhängenden Brückenzugs
    h.length = h.type === 'over' ? Math.max(h.alongEnd - h.along, h.wayLength) : h.wayLength;
  });
  return merged;
}

function maxDefined(a, b) {
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
}

/**
 * Brücken sind in OSM oft in mehrere Wege geteilt. Wege, die an einem Ende
 * aneinanderstoßen und in gleicher Richtung weiterlaufen, werden zu einem
 * Brückenzug zusammengefasst; groupLength ist dessen Gesamtlänge.
 */
export function computeGroups(bridges) {
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const ends = new Map();
  const key = (p) => p.lat.toFixed(7) + ',' + p.lon.toFixed(7);
  for (const b of bridges.values()) {
    parent.set(b.id, b.id);
    const g = b.geom;
    for (const [p, q] of [[g[0], g[1]], [g[g.length - 1], g[g.length - 2]]]) {
      const k = key(p);
      let arr = ends.get(k);
      if (!arr) ends.set(k, (arr = []));
      arr.push({ b, dir: bearing(p, q) });
    }
  }
  for (const arr of ends.values()) {
    // Nur gerade Fortsetzungen verbinden: Die Richtungen vom gemeinsamen Punkt
    // weg müssen (fast) entgegengesetzt sein. Treffen sich mehr als zwei Wege
    // (z. B. Rampe zweigt ab), werden nur die geradesten Paare verbunden –
    // jedes Wegende höchstens einmal.
    const pairs = [];
    for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
      const A = arr[i], B = arr[j];
      if (A.b.kind !== B.b.kind || A.b === B.b) continue;
      const ta = A.b.tags, tb = B.b.tags;
      if (ta.ref && tb.ref && ta.ref !== tb.ref) continue;
      if (!ta.ref && !tb.ref && ta.name && tb.name && ta.name !== tb.name) continue;
      const opp = Math.abs(angleDiff(A.dir, B.dir));
      if (opp >= 150) pairs.push([opp, i, j]);
    }
    pairs.sort((x, y) => y[0] - x[0]);
    const used = new Set();
    for (const [, i, j] of pairs) {
      if (used.has(i) || used.has(j)) continue;
      used.add(i); used.add(j);
      parent.set(find(arr[i].b.id), find(arr[j].b.id));
    }
  }
  const sums = new Map();
  for (const b of bridges.values()) { const r = find(b.id); sums.set(r, (sums.get(r) || 0) + b.length); }
  for (const b of bridges.values()) b.groupLength = sums.get(find(b.id));
}

function minDefined(a, b) {
  if (a == null) return b;
  if (b == null) return a;
  return Math.min(a, b);
}
