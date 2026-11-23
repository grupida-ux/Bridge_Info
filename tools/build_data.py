#!/usr/bin/env python3
"""
Bereitet OpenStreetMap-Daten für Brücken-Info auf.

Eingabe:  eine (vorgefilterte) OSM-Datei, z. B. aus
          osmium tags-filter germany-latest.osm.pbf w/highway=... w/bridge
Ausgabe:  <out>/manifest.json
          <out>/roads/<r>_<c>.json.gz     Hauptstraßen je Kachel
          <out>/bridges/<r>_<c>.json.gz   alle Straßen- und Bahnbrücken je Kachel
          (gzip-gepackt; GitHub Pages erlaubt ca. 1 GB, gepackt bleibt
          Deutschland deutlich darunter. Die App entpackt selbst.)

Kachelraster: 0,1° Breite × 0,15° Länge (in Deutschland ca. 11 × 10 km).
Koordinaten werden als ganze Zahlen (Grad × 10^7) gespeichert, ab dem
zweiten Punkt als Differenz zum Vorgänger – das hält die Dateien klein.

Format einer Kachel:  {"v":1,"ways":[[id, {tags}, [lat0, lon0, dlat1, dlon1, ...]], ...]}
"""
import argparse
import datetime as dt
import gzip
import json
import os
import sys

import osmium

TILE_LAT = 1_000_000   # 0,1°  in 10^-7 Grad
TILE_LON = 1_500_000   # 0,15° in 10^-7 Grad

MAJOR = {
    'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
    'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified', 'road', 'busway',
}
DEAD = {'proposed', 'construction', 'abandoned', 'razed', 'disused', 'planned', 'demolished'}
KEEP = (
    'highway', 'railway', 'oneway', 'junction', 'ref', 'name', 'bridge', 'bridge:name',
    'maxweight', 'maxheight', 'maxheight:physical', 'height', 'bridge:height',
)


def tile_of(y, x):
    return (y // TILE_LAT, x // TILE_LON)


class Collector(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.roads = {}
        self.bridges = {}
        self.n_roads = 0
        self.n_bridges = 0
        self.skipped = 0

    def way(self, w):
        t = w.tags
        hw = t.get('highway')
        rw = t.get('railway')
        br = t.get('bridge')
        if (hw and hw in DEAD) or (rw and rw in DEAD):
            return
        is_road = hw in MAJOR and t.get('area') != 'yes'
        is_bridge = bool(br) and br != 'no' and bool(hw or rw)
        if not (is_road or is_bridge):
            return
        pts = []
        try:
            for n in w.nodes:
                loc = n.location
                if not loc.valid():
                    raise ValueError
                pts.append((loc.y, loc.x))
        except (ValueError, osmium.InvalidLocationError):
            self.skipped += 1
            return
        if len(pts) < 2:
            return
        tags = {k: t.get(k) for k in KEEP if k in t}
        flat = [pts[0][0], pts[0][1]]
        for (y0, x0), (y1, x1) in zip(pts, pts[1:]):
            flat.append(y1 - y0)
            flat.append(x1 - x0)
        # sofort als kompakten JSON-Text ablegen (spart bei ganz Deutschland
        # mehrere GB Arbeitsspeicher gegenüber Python-Listen)
        entry = json.dumps([w.id, tags, flat], separators=(',', ':'), ensure_ascii=False)
        tiles = set()
        for (y0, x0), (y1, x1) in zip(pts, pts[1:]):
            r0, c0 = tile_of(min(y0, y1), min(x0, x1))
            r1, c1 = tile_of(max(y0, y1), max(x0, x1))
            for r in range(r0, r1 + 1):
                for c in range(c0, c1 + 1):
                    tiles.add((r, c))
        if is_road:
            self.n_roads += 1
            for k in tiles:
                self.roads.setdefault(k, []).append(entry)
        if is_bridge:
            self.n_bridges += 1
            for k in tiles:
                self.bridges.setdefault(k, []).append(entry)


def read_poly(path, tol=0.005):
    """Geofabrik-.poly lesen (nur äußere Ringe) und vereinfachen."""
    rings, cur, inner = [], None, False
    with open(path) as f:
        lines = [l.strip() for l in f if l.strip()]
    for l in lines[1:]:
        if l == 'END':
            if cur is not None:
                if not inner:
                    rings.append(cur)
                cur = None
            continue
        if cur is None:
            inner = l.startswith('!')
            cur = []
            continue
        lon, lat = map(float, l.split()[:2])
        cur.append((round(lat, 4), round(lon, 4)))
    return [simplify(r, tol) for r in rings if len(r) > 3]


def simplify(pts, tol):
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        s, e = stack.pop()
        (ay, ax), (by, bx) = pts[s], pts[e]
        dy, dx = by - ay, bx - ax
        L2 = dx * dx + dy * dy
        best, idx = -1, -1
        for i in range(s + 1, e):
            py, px = pts[i]
            if L2 == 0:
                d = ((py - ay) ** 2 + (px - ax) ** 2) ** 0.5
            else:
                d = abs(dy * (px - ax) - dx * (py - ay)) / L2 ** 0.5
            if d > best:
                best, idx = d, i
        if best > tol:
            keep[idx] = True
            stack += [(s, idx), (idx, e)]
    return [p for p, k in zip(pts, keep) if k]


def write_tiles(base, name, tiles):
    os.makedirs(os.path.join(base, name), exist_ok=True)
    total = 0
    for (r, c), ways in tiles.items():
        data = ('{"v":1,"ways":[' + ','.join(ways) + ']}').encode('utf-8')
        packed = gzip.compress(data, compresslevel=9, mtime=0)
        with open(os.path.join(base, name, f'{r}_{c}.json.gz'), 'wb') as f:
            f.write(packed)
        total += len(packed)
    return total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('input')
    ap.add_argument('out')
    ap.add_argument('--poly', help='Geofabrik-.poly-Datei des abgedeckten Gebiets')
    ap.add_argument('--source', default='OpenStreetMap')
    args = ap.parse_args()

    osm_date = None
    try:
        hdr = osmium.io.Reader(args.input, osmium.osm.osm_entity_bits.NOTHING).header()
        osm_date = hdr.get('osmosis_replication_timestamp') or None
    except Exception:
        pass

    col = Collector()
    col.apply_file(args.input, locations=True, idx='flex_mem')
    print(f'Straßen: {col.n_roads}, Brücken: {col.n_bridges}, ohne Koordinaten übersprungen: {col.skipped}', file=sys.stderr)

    rb = write_tiles(args.out, 'roads', col.roads)
    bb = write_tiles(args.out, 'bridges', col.bridges)
    print(f'Kacheln Straßen: {len(col.roads)} ({rb / 1e6:.1f} MB), Brücken: {len(col.bridges)} ({bb / 1e6:.1f} MB)', file=sys.stderr)

    manifest = {
        'v': 1,
        'built': dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'osm_date': osm_date,
        'source': args.source,
        'grid': {'lat': TILE_LAT / 1e7, 'lon': TILE_LON / 1e7},
        'roads': sorted(f'{r}_{c}' for r, c in col.roads),
        'bridges': sorted(f'{r}_{c}' for r, c in col.bridges),
        'area': read_poly(args.poly) if args.poly else None,
    }
    with open(os.path.join(args.out, 'manifest.json'), 'w', encoding='utf-8') as f:
        json.dump(manifest, f, separators=(',', ':'))


if __name__ == '__main__':
    main()
