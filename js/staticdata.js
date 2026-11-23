// Vorab aufbereitete OSM-Daten von der eigenen GitHub-Pages-Seite
// (erzeugt monatlich von tools/build_data.py über GitHub Actions).
// Ersetzt die Overpass-Abfragen für Hauptstraßen und Brücken in Deutschland.
import { parseBridges } from './bridges.js';
import { densify, Polyline } from './geo.js';

const BASE = 'data/';
const DATA_CACHE = 'bridgeinfo-data';
const MAX_MEM_TILES = 80;

export class StaticData {
  constructor() {
    this.manifest = null;
    this.ready = null;
    this.mem = new Map(); // "kind/key" -> Promise<elements[]>
  }

  /** manifest.json laden; ohne Daten (z. B. lokal) bleibt alles bei Overpass */
  init() {
    this.ready ??= fetch(BASE + 'manifest.json', { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => {
        if (!m || m.v !== 1) return null;
        if (typeof DecompressionStream === 'undefined') return null; // sehr alte Browser: Overpass
        this.manifest = m;
        this.roadSet = new Set(m.roads);
        this.bridgeSet = new Set(m.bridges);
        this.gLat = Math.round(m.grid.lat * 1e7);
        this.gLon = Math.round(m.grid.lon * 1e7);
        this.purgeOld(m.built);
        return m;
      })
      .catch(() => null);
    return this.ready;
  }

  get available() { return !!this.manifest; }

  /** Zwischengespeicherte Kacheln älterer Datenstände entfernen */
  async purgeOld(version) {
    try {
      const cache = await caches.open(DATA_CACHE);
      for (const req of await cache.keys()) {
        if (new URL(req.url).searchParams.get('v') !== version) cache.delete(req);
      }
    } catch { /* Cache API nicht verfügbar */ }
  }

  tileKey(p) {
    return `${Math.floor(Math.round(p.lat * 1e7) / this.gLat)}_${Math.floor(Math.round(p.lon * 1e7) / this.gLon)}`;
  }

  tileCenter(key) {
    const [r, c] = key.split('_').map(Number);
    return { lat: ((r + 0.5) * this.gLat) / 1e7, lon: ((c + 0.5) * this.gLon) / 1e7 };
  }

  /** Liegt der Punkt im abgedeckten Gebiet (Deutschland)? */
  covers(p) {
    if (!this.manifest) return false;
    const area = this.manifest.area;
    if (area) return area.some((ring) => inRing(p, ring));
    return this.roadSet.has(this.tileKey(p));
  }

  /** Kachel laden: Liste von Wegen im Overpass-Format {type, id, tags, geometry} */
  tile(kind, key) {
    const set = kind === 'roads' ? this.roadSet : this.bridgeSet;
    if (!set?.has(key)) return Promise.resolve([]);
    const id = kind + '/' + key;
    let pr = this.mem.get(id);
    if (!pr) {
      const url = `${BASE}${kind}/${key}.json.gz?v=${encodeURIComponent(this.manifest.built)}`;
      pr = fetch(url)
        .then((r) => { if (!r.ok) throw new Error(`Daten-Kachel ${key}: ${r.status}`); return r.arrayBuffer(); })
        .then(unpackJson)
        .then((j) => decode(j.ways));
      pr.catch(() => this.mem.delete(id));
      this.mem.set(id, pr);
      if (this.mem.size > MAX_MEM_TILES) this.mem.delete(this.mem.keys().next().value);
    }
    return pr;
  }

  /** Straßen + Brücken einer Kachel (für den Modus „Straße folgen“) */
  async roadTile(key) {
    const [roads, bridges] = await Promise.all([this.tile('roads', key), this.tile('bridges', key)]);
    return roads.concat(bridges);
  }

  /**
   * Brücken in der Nähe einer Linie (Routenabschnitt): lädt die berührten
   * Kacheln und behält nur Brücken, die höchstens `maxDist` m entfernt sind.
   */
  async bridgesNear(points, maxDist = 40) {
    const keys = new Set();
    for (const p of densify(points, 100)) {
      for (const [dy, dx] of [[0, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        keys.add(this.tileKey({ lat: p.lat + dy * 0.0006, lon: p.lon + dx * 0.0009 }));
      }
    }
    const els = new Map();
    for (const k of keys) for (const e of await this.tile('bridges', k)) els.set(e.id, e);
    const all = parseBridges({ elements: [...els.values()] });
    const line = new Polyline(points);
    const out = new Map();
    for (const [id, b] of all) {
      if (b.dense.some((p) => { const m = line.locateNear(p); return m && m.dist <= maxDist; })) out.set(id, b);
    }
    return out;
  }
}

/** gzip-Daten entpacken (falls der Server sie nicht schon entpackt geliefert hat) */
async function unpackJson(buf) {
  const u8 = new Uint8Array(buf);
  if (u8[0] === 0x1f && u8[1] === 0x8b) {
    const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).json();
  }
  return JSON.parse(new TextDecoder().decode(u8));
}

function decode(ways) {
  return ways.map(([id, tags, f]) => {
    let y = f[0], x = f[1];
    const geometry = [{ lat: y / 1e7, lon: x / 1e7 }];
    for (let i = 2; i < f.length; i += 2) {
      y += f[i];
      x += f[i + 1];
      geometry.push({ lat: y / 1e7, lon: x / 1e7 });
    }
    return { type: 'way', id, tags, geometry };
  });
}

/** Punkt-in-Polygon (Ring als [[lat, lon], ...]) */
function inRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i], [yj, xj] = ring[j];
    if ((yi > p.lat) !== (yj > p.lat) && p.lon < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export const staticData = new StaticData();
