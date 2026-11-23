// Brücken-Info – Hauptlogik
import { distance, bearing, destination, Polyline } from './geo.js';
import { fetchBridgesAlongChunk, routeChunks, bridgesAhead, matchBridgesToRoute, computeGroups } from './bridges.js';
import { geocode, route as calcRoute } from './route.js';
import { TileStore, predictBridges } from './roads.js';
import { staticData } from './staticdata.js';
import { unlockAudio, beep, speak, vibrate } from './alerts.js';

/* ---------------- Einstellungen ---------------- */
const DEFAULTS = {
  alertDistance: 500,   // m – Ansage vor der Brücke
  vehicleHeight: 0,     // m – 0 = nicht prüfen
  vehicleWeight: 0,     // t – 0 = nicht prüfen
  speech: true,
  sound: true,
  vibration: true,
  showUnder: false,     // Unterführungen (unter Brücken durch) anzeigen
  demoSpeed: 80,        // km/h
  demoFactor: 2,        // Zeitraffer
};
const settings = { ...DEFAULTS, ...load('bridgeinfo.settings', {}) };

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* privat/blockiert */ }
}

/* ---------------- Zustand ---------------- */
const state = {
  tracking: false,
  watchId: null,
  demoTimer: null,
  demoAlong: 0,
  pos: null,
  heading: null,
  speed: 0,
  headingRef: null,
  // freie Fahrt
  bridges: new Map(),
  network: null,        // Straßennetz der Umgebung (Modus ohne Ziel)
  tiles: new TileStore(staticData),
  predEnd: null,        // Ende des vorhergesagten Weges (für Vorausladen)
  matchWayId: null,     // zuletzt befahrene Straße
  loadingArea: false,
  lastLoadFail: 0,
  // Route
  route: null,
  routeInfo: null,
  routeBridges: [],
  routeHint: null,
  offRouteCount: 0,
  lastReroute: 0,
  dest: null,
  // Warnungen
  fired: new Set(),
  firedPoints: [],
  follow: true,
  wakeLock: null,
  abort: null,
};

/* ---------------- Karte ---------------- */
const $ = (id) => document.getElementById(id);
const map = L.map('map', { zoomControl: false, attributionControl: true }).setView([51.16, 10.45], 6);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende',
}).addTo(map);
L.control.zoom({ position: 'topright' }).addTo(map);

const areaLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const routeBridgeLayer = L.layerGroup().addTo(map);
let nextHighlight = null;

const vehicleIcon = L.divIcon({
  className: 'vehicle',
  html: '<div class="vehicle-arrow"><svg viewBox="0 0 40 40" width="40" height="40"><path d="M20 3 L33 35 L20 28 L7 35 Z"/></svg></div>',
  iconSize: [40, 40],
  iconAnchor: [20, 20],
});
let vehicleMarker = null;
let accuracyCircle = null;
let destMarker = null;

map.on('dragstart', () => setFollow(false));
map.on('contextmenu', (e) => {
  setDestination({ lat: e.latlng.lat, lon: e.latlng.lng, label: 'Markierter Punkt' });
});

function setFollow(v) {
  state.follow = v;
  $('btn-center').classList.toggle('active', v);
  if (v && state.pos) { map.setZoom(Math.max(map.getZoom(), 15), { animate: false }); followTo([state.pos.lat, state.pos.lon]); }
}

/* ---------------- Formatierung ---------------- */
const nf1 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });
function fmtDist(m) {
  if (m < 995) return `${Math.max(0, Math.round(m / 10) * 10)} m`;
  return `${nf1.format(m / 1000)} km`;
}
function speechDist(m) {
  if (m < 1000) {
    const r = m < 200 ? Math.round(m / 10) * 10 : Math.round(m / 50) * 50;
    if (r < 1000) return `${r} Metern`;
  }
  const km = nf1.format(m / 1000);
  return km === '1' ? '1 Kilometer' : `${km} Kilometern`;
}
const TYPE_LABEL = { over: 'Brücke (Überfahrt)', under: 'Unterführung' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Prüft Höhe / Gewicht gegen das eigene Fahrzeug */
function conflict(item) {
  if (item.type === 'under' && settings.vehicleHeight > 0 && item.maxheight != null && item.maxheight < settings.vehicleHeight + 0.1)
    return `Durchfahrtshöhe ${nf1.format(item.maxheight)} m – Ihr Fahrzeug ist ${nf1.format(settings.vehicleHeight)} m hoch!`;
  if (item.type === 'over' && settings.vehicleWeight > 0 && item.maxweight != null && item.maxweight < settings.vehicleWeight)
    return `Höchstgewicht ${nf1.format(item.maxweight)} t – Ihr Fahrzeug wiegt ${nf1.format(settings.vehicleWeight)} t!`;
  return null;
}

/**
 * Unterführungen nur zeigen, wenn eingeschaltet – oder wenn sie für das
 * eigene Fahrzeug zu niedrig sind (Sicherheitswarnung).
 */
function visible(item) {
  return item.type !== 'under' || settings.showUnder || !!conflict(item);
}

const fmtLen = (m) => (m >= 1000 ? `${nf1.format(m / 1000)} km` : `${Math.max(1, Math.round(m))} m`);

function details(item) {
  const d = [];
  if (item.type !== 'under' && item.length > 0) d.push(item.partial ? `noch ${fmtLen(item.length)}` : `${fmtLen(item.length)} lang`);
  if (item.height != null) d.push(`${nf1.format(item.height)} m hoch`);
  if (item.maxheight != null) d.push(`max. Höhe ${nf1.format(item.maxheight)} m`);
  if (item.maxweight != null) d.push(`max. ${nf1.format(item.maxweight)} t`);
  return d.join(' · ');
}

/* ---------------- Positionsverarbeitung ---------------- */
function onPosition(p) {
  const pos = { lat: p.lat, lon: p.lon };
  const prev = state.pos;
  state.pos = pos;
  // Geschwindigkeit: vom GPS, sonst aus der Positionsänderung. Ausreißer
  // (GPS-Sprünge, sehr kurze Zeitabstände) auf plausible Werte begrenzen.
  let v = p.speed != null && !Number.isNaN(p.speed) ? p.speed
    : prev && p.dt >= 0.5 ? distance(prev, pos) / p.dt : state.speed;
  state.speed = Math.max(0, Math.min(v || 0, 70)); // max. ~250 km/h

  // Fahrtrichtung: GPS-Kurs bei Fahrt, sonst aus Positionsverlauf
  if (p.heading != null && !Number.isNaN(p.heading) && state.speed > 1.5) {
    state.heading = p.heading;
    state.headingRef = pos;
  } else if (!state.headingRef) {
    state.headingRef = pos;
  } else if (distance(state.headingRef, pos) > 12) {
    state.heading = bearing(state.headingRef, pos);
    state.headingRef = pos;
  }

  updateVehicle(pos, p.accuracy);
  updateStatus(p.accuracy);

  let upcoming = [];
  let mode = 'free';

  if (state.route && !state.demoNoRoute) {
    const m = state.route.locate(pos, state.routeHint);
    if (m && m.dist < 60) {
      mode = 'route';
      state.routeHint = m.index;
      state.routeAlong = m.along;
      state.offRouteCount = 0;
      if (state.heading == null || state.speed < 1.5) state.heading = state.route.bearingAt(m.index);
      upcoming = state.routeBridges
        .filter((b) => b.alongEnd >= m.along - 5 && visible(b))
        .map((b) => ({ ...b, distance: b.along - m.along, onIt: b.along <= m.along }));
      const remaining = state.route.length - m.along;
      $('route-remaining').textContent = `Noch ${fmtDist(remaining)} bis zum Ziel`;
      if (remaining < 30 && !state.arrived) { state.arrived = true; toast('Ziel erreicht'); }
    } else {
      state.offRouteCount++;
      if (state.offRouteCount >= 4 && !state.demoTimer && Date.now() - state.lastReroute > 30000 && state.dest) {
        state.lastReroute = Date.now();
        toast('Route verlassen – neue Route wird berechnet');
        planRoute(state.dest, true);
      }
    }
  }

  if (mode === 'free') {
    const look = Math.min(2500, Math.max(800, state.speed * 45, settings.alertDistance * 1.6));
    ensureAreaData(pos, state.heading, look);
    let pred = null;
    if (state.heading != null && state.network && state.tiles.has(pos)) {
      const withUnder = settings.showUnder || settings.vehicleHeight > 0;
      pred = predictBridges(state.network, state.bridges, pos, state.heading, look, state.matchWayId, withUnder);
    }
    if (pred) {
      // Straße erkannt: ihrem Verlauf vorausfolgen
      mode = 'follow';
      state.matchWayId = pred.wayId;
      // Endet die Vorhersage vor dem Horizont (Datenrand), dort Daten nachladen
      state.predEnd = pred.length < look - 50
        ? { point: pred.points[pred.points.length - 1], along: pred.length, minor: pred.endMinor } : null;
      upcoming = pred.items.filter(visible);
      drawPrediction(pred.points);
    } else {
      // keine Straße zugeordnet (Daten fehlen, Parkplatz …): geradeaus schauen
      state.matchWayId = null;
      drawPrediction(null);
      if (state.heading != null) {
        upcoming = bridgesAhead(state.bridges, pos, state.heading, look).map((c) => ({
          key: 'f' + c.bridge.id,
          bridge: c.bridge,
          name: c.bridge.name,
          type: c.type,
          distance: c.distance,
          point: c.point,
          onIt: c.onIt,
          maxheight: c.bridge.maxheight,
          maxweight: c.bridge.maxweight,
          length: c.bridge.groupLength ?? c.bridge.length,
          height: c.bridge.height,
        })).filter(visible);
      }
    }
  } else drawPrediction(null);

  state.mode = mode;
  renderNext(upcoming, mode);
  renderRouteList(upcoming, mode);
  checkAlerts(upcoming, mode);
}

function updateVehicle(pos, acc) {
  const ll = [pos.lat, pos.lon];
  if (!vehicleMarker) {
    vehicleMarker = L.marker(ll, { icon: vehicleIcon, interactive: false, zIndexOffset: 1000 }).addTo(map);
    accuracyCircle = L.circle(ll, { radius: acc || 10, className: 'accuracy', interactive: false }).addTo(map);
    map.setView(ll, 16);
  } else {
    vehicleMarker.setLatLng(ll);
    accuracyCircle.setLatLng(ll).setRadius(acc || 10);
  }
  const el = vehicleMarker.getElement()?.querySelector('.vehicle-arrow');
  if (el) {
    el.style.transform = `rotate(${state.heading ?? 0}deg)`;
    el.classList.toggle('no-heading', state.heading == null);
  }
  if (state.follow) followTo(ll);
}

/** Fahrzeug im sichtbaren Bereich oberhalb des Panels halten */
function followTo(ll) {
  const size = map.getSize();
  const sheet = $('sheet').getBoundingClientRect();
  const covered = window.innerWidth < 760 ? sheet.height : 0;
  const want = L.point(size.x / 2, Math.max(120, (size.y - covered) * 0.75));
  const now = map.latLngToContainerPoint(ll);
  const shift = now.subtract(want);
  if (Math.abs(shift.x) + Math.abs(shift.y) > 2) map.panBy(shift, { animate: true, duration: 0.5 });
}

function updateStatus(acc) {
  const kmh = Math.round((state.speed || 0) * 3.6);
  const parts = [];
  parts.push(state.demoTimer ? 'Demo' : 'GPS');
  if (acc) parts.push(`±${Math.round(acc)} m`);
  parts.push(`${kmh} km/h`);
  if (state.heading != null) parts.push(`${Math.round(state.heading)}°`);
  $('status').textContent = parts.join(' · ');
}

/* ---------------- Straßen + Brücken der Umgebung laden (ohne Ziel) ---------------- */
/**
 * Lädt im Hintergrund nacheinander die Kacheln, die als Nächstes gebraucht
 * werden. Vorhandene Daten bleiben nutzbar, solange geladen wird.
 */
function ensureAreaData(pos, heading, look) {
  const tiles = state.tiles;
  if (tiles.loading) return;
  const todo = tiles.needed(pos, heading, state.speed || 0, look, state.predEnd, destination);
  if (!todo.length) { setLoadIndicator(false); return; }
  const w = todo[0];
  const missingHere = !tiles.has(pos);
  if (missingHere) setInfo('Lade Straßendaten für Ihre Position …');
  setLoadIndicator(true);
  tiles.load(w)
    .then(() => {
      tiles.prune(pos);
      const { network, bridges } = tiles.build(state.pos || pos);
      state.network = network;
      for (const [id, b] of bridges) state.bridges.set(id, b);
      if (state.bridges.size > 8000) {
        for (const [id, b] of state.bridges) if (distance(b.geom[0], pos) > 25000) state.bridges.delete(id);
      }
      computeGroups(state.bridges);
      drawAreaBridges();
      if (missingHere) setInfo('Straßendaten geladen');
    })
    .catch((e) => {
      console.warn(e);
      if (!tiles.has(state.pos || pos)) setInfo('Straßendaten konnten nicht geladen werden (Funkloch oder Server überlastet) – neuer Versuch …');
    })
    .finally(() => {
      // gleich die nächste benötigte Kachel holen
      if (state.tracking && state.pos && state.mode !== 'route') {
        const l = Math.min(2500, Math.max(800, (state.speed || 0) * 45, settings.alertDistance * 1.6));
        setTimeout(() => ensureAreaData(state.pos, state.heading, l), 200);
      } else setLoadIndicator(false);
    });
}

function setLoadIndicator(on) {
  $('status').classList.toggle('loading', on);
}

/* Vorhergesagter Weg (gestrichelt) */
let predictionLine = null;
function drawPrediction(points) {
  if (!points) { if (predictionLine) { map.removeLayer(predictionLine); predictionLine = null; } return; }
  const ll = points.map((p) => [p.lat, p.lon]);
  if (predictionLine) predictionLine.setLatLngs(ll);
  else predictionLine = L.polyline(ll, { className: 'predict-line', weight: 6, interactive: false }).addTo(map);
}

function drawAreaBridges() {
  areaLayer.clearLayers();
  for (const b of state.bridges.values()) {
    if (b.kind !== 'road' && !settings.showUnder) continue;
    L.polyline(b.geom.map((p) => [p.lat, p.lon]), { className: `bridge-line kind-${b.kind}`, weight: 5 })
      .bindPopup(popupHtml({ name: b.name, maxheight: b.maxheight, maxweight: b.maxweight, length: b.groupLength ?? b.length, height: b.height }, b))
      .addTo(areaLayer);
  }
}

function popupHtml(item, b) {
  const d = details(item);
  const t = b?.tags || {};
  const extra = [t.highway && `highway=${t.highway}`, t.railway && `railway=${t.railway}`].filter(Boolean).join(', ');
  return `<strong>${esc(item.name)}</strong>${item.type ? `<br>${TYPE_LABEL[item.type]}` : ''}${d ? `<br>${esc(d)}` : ''}${extra ? `<br><small>${esc(extra)}</small>` : ''}${b ? `<br><a href="https://www.openstreetmap.org/way/${b.id}" target="_blank" rel="noopener">In OSM ansehen</a>` : ''}`;
}

/* ---------------- Anzeige ---------------- */
function renderNext(upcoming, mode) {
  const box = $('next');
  const item = upcoming.find((u) => !u.onIt) || upcoming[0];
  $('mode').textContent = mode === 'route' ? 'Route'
    : state.route && !state.demoNoRoute ? 'Abseits der Route'
    : mode === 'follow' ? 'Straße folgen' : 'Geradeaus';
  if (!state.tracking) return;
  if (!item) {
    box.className = 'next empty';
    box.innerHTML = state.heading == null
      ? '<div class="next-title">Warte auf Fahrtrichtung …</div><div class="next-sub">Losfahren oder Route planen</div>'
      : routeDataMissing(mode)
        ? '<div class="next-title">Brückendaten werden noch geladen</div><div class="next-sub">Für den vor Ihnen liegenden Abschnitt fehlen noch Daten – bitte auf Schilder achten</div>'
        : `<div class="next-title">Keine Brücke voraus</div><div class="next-sub">${mode === 'route' ? 'auf der restlichen Route' : mode === 'follow' ? 'im weiteren Straßenverlauf' : 'in Fahrtrichtung'}</div>`;
    highlight(null);
    return;
  }
  const warn = conflict(item);
  box.className = `next ${warn ? 'danger' : item.distance < settings.alertDistance ? 'near' : ''}`;
  box.innerHTML = `
    <div class="next-icon">${item.type === 'under' ? iconUnder : iconOver}</div>
    <div class="next-body">
      <div class="next-dist">${item.onIt ? 'Jetzt' : fmtDist(item.distance)}</div>
      <div class="next-title">${esc(item.name)}</div>
      <div class="next-sub">${TYPE_LABEL[item.type]}${details(item) ? ' · ' + esc(details(item)) : ''}</div>
      ${warn ? `<div class="next-warn">⚠ ${esc(warn)}</div>` : ''}
    </div>`;
  highlight(item);
}

/** Fehlen für die nächsten Kilometer der Route noch Daten? */
function routeDataMissing(mode) {
  if (mode !== 'route' || !state.routeChunks) return false;
  const a = state.routeAlong ?? 0;
  return state.routeChunks.some((c) => !c.done && c.to >= a && c.from <= a + 3000);
}

function highlight(item) {
  if (nextHighlight) { map.removeLayer(nextHighlight); nextHighlight = null; }
  if (!item) return;
  const geoms = (item.bridges || [item.bridge]).map((b) => b.geom.map((p) => [p.lat, p.lon]));
  nextHighlight = L.polyline(geoms, { className: 'bridge-next', weight: 10, interactive: false }).addTo(map);
}

function renderRouteList(upcoming, mode) {
  const list = $('route-list');
  if (!state.route) { list.innerHTML = ''; return; }
  const items = mode === 'route' ? upcoming : state.routeBridges.map((b) => ({ ...b, distance: null }));
  $('route-count').textContent = `${items.length} ${items.length === 1 ? 'Brücke' : 'Brücken'}`;
  list.innerHTML = items.slice(0, 60).map((i) => {
    const w = conflict(i);
    return `<li class="${w ? 'danger' : ''}" data-lat="${i.point.lat}" data-lon="${i.point.lon}">
      <span class="li-dist">${i.distance == null ? fmtDist(i.along) : i.onIt ? 'jetzt' : fmtDist(i.distance)}</span>
      <span class="li-name">${esc(i.name)}<small>${TYPE_LABEL[i.type]}${details(i) ? ' · ' + esc(details(i)) : ''}</small></span>
      ${w ? '<span class="li-warn">⚠</span>' : ''}</li>`;
  }).join('');
}

$('route-list').addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  setFollow(false);
  map.setView([+li.dataset.lat, +li.dataset.lon], 17);
});

const iconOver = '<svg viewBox="0 0 48 48"><path d="M4 30h40M8 30v10M40 30v10M4 30c8-14 32-14 40 0" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>';
const iconUnder = '<svg viewBox="0 0 48 48"><path d="M4 14h40v6H4zM10 20v22M38 20v22" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M24 44V28m-5 5 5-5 5 5" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/* ---------------- Warnungen ---------------- */
function checkAlerts(upcoming, mode) {
  const now = Date.now();
  state.firedPoints = state.firedPoints.filter((f) => now - f.t < 10 * 60 * 1000);
  for (const item of upcoming) {
    const warn = conflict(item);
    const threshold = warn ? Math.max(settings.alertDistance, 1500) : settings.alertDistance;
    if (item.distance > threshold) continue;
    if (state.fired.has(item.key)) continue;
    // Bereits auf der Brücke (z. B. lange Hochstraße aus vielen Teilstücken): keine neue Ansage
    if (item.onIt) { state.fired.add(item.key); continue; }
    // Doppelte Meldungen (z. B. zweite Richtungsfahrbahn) vermeiden
    if (state.firedPoints.some((f) => f.type === item.type && distance(f.p, item.point) < 120)) {
      state.fired.add(item.key);
      continue;
    }
    state.fired.add(item.key);
    state.firedPoints.push({ p: item.point, t: now, type: item.type });
    fireAlert(item, warn);
    break; // eine Ansage pro Update
  }
}

function fireAlert(item, warn) {
  const where = item.onIt || item.distance < 40 ? 'Jetzt' : `In ${speechDist(item.distance)}`;
  const what = item.type === 'under' ? 'Unterführung unter einer Brücke' : 'Brücke';
  let text = `${where}: ${what}`;
  if (item.name && !/^(Straßen|Eisenbahn|Fuß)/.test(item.name)) text += `, ${item.name}`;
  if (warn) text = `Achtung! ${text}. ${warn.replace(/ m\b/g, ' Meter').replace(/ t\b/g, ' Tonnen').replace(/!$/, '')}!`;
  else if (item.type === 'under' && item.maxheight != null) text += `. Durchfahrtshöhe ${nf1.format(item.maxheight)} Meter`;
  if (!warn && item.type === 'over' && item.length >= 20) {
    text += `, ${item.length >= 1000 ? `${nf1.format(item.length / 1000)} Kilometer` : `${Math.round(item.length / 10) * 10} Meter`} lang`;
    if (item.height != null) text += `, ${nf1.format(item.height)} Meter hoch`;
  }

  const banner = $('alert');
  banner.className = `alert show ${warn ? 'danger' : ''}`;
  banner.innerHTML = `<div class="alert-icon">${item.type === 'under' ? iconUnder : iconOver}</div>
    <div><div class="alert-title">${item.onIt ? 'Jetzt' : fmtDist(item.distance)}: ${esc(TYPE_LABEL[item.type])}</div>
    <div class="alert-sub">${esc(item.name)}${details(item) ? ' · ' + esc(details(item)) : ''}</div>
    ${warn ? `<div class="alert-warn">⚠ ${esc(warn)}</div>` : ''}</div>`;
  clearTimeout(fireAlert.t);
  fireAlert.t = setTimeout(() => banner.classList.remove('show'), warn ? 15000 : 8000);

  if (settings.sound) beep(!!warn);
  if (settings.vibration) vibrate(!!warn);
  if (settings.speech) setTimeout(() => speak(text), settings.sound ? 450 : 0);
  log(text);
}

/* ---------------- GPS starten/stoppen ---------------- */
async function start() {
  unlockAudio();
  if (!('geolocation' in navigator)) { toast('Dieses Gerät unterstützt keine Ortung'); return; }
  stopDemo();
  state.tracking = true;
  updateStartButton();
  setInfo('Warte auf GPS-Signal …');
  let lastTs = null;
  state.watchId = navigator.geolocation.watchPosition(
    (g) => {
      const c = g.coords;
      const dt = lastTs ? (g.timestamp - lastTs) / 1000 : null;
      lastTs = g.timestamp;
      onPosition({ lat: c.latitude, lon: c.longitude, accuracy: c.accuracy, speed: c.speed, heading: c.heading, dt });
    },
    (err) => {
      const msg = err.code === 1 ? 'Standortzugriff verweigert – bitte in den Browser-Einstellungen erlauben'
        : err.code === 3 ? 'GPS-Zeitüberschreitung – suche weiter …' : 'Standort nicht verfügbar';
      setInfo(msg);
      if (err.code === 1) stop();
    },
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 },
  );
  requestWakeLock();
}

function stop() {
  if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  stopDemo();
  state.tracking = false;
  updateStartButton();
  releaseWakeLock();
  $('next').className = 'next empty';
  $('next').innerHTML = '<div class="next-title">Pausiert</div><div class="next-sub">„Start“ tippen, um die Überwachung zu beginnen</div>';
}

function updateStartButton() {
  const b = $('btn-start');
  const on = state.tracking;
  b.textContent = on ? (state.demoTimer ? 'Demo stoppen' : 'Stopp') : 'Start';
  b.classList.toggle('on', on);
}

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      state.wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch { /* nicht erlaubt */ }
}
function releaseWakeLock() {
  try { state.wakeLock?.release(); } catch { /* ignorieren */ }
  state.wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.tracking) requestWakeLock();
});

/* ---------------- Route ---------------- */
async function setDestination(dest) {
  state.dest = dest;
  if (destMarker) map.removeLayer(destMarker);
  destMarker = L.marker([dest.lat, dest.lon], { title: dest.label }).addTo(map).bindPopup(esc(dest.label));
  await planRoute(dest);
}

async function planRoute(dest, silent = false) {
  state.abort?.abort();
  const ctrl = (state.abort = new AbortController());
  const from = state.pos || { lat: map.getCenter().lat, lon: map.getCenter().lng };
  if (!state.pos && !silent) toast('Kein GPS – Route startet am Kartenmittelpunkt');
  setInfo('Berechne Route …');
  try {
    const r = await calcRoute(from, dest, ctrl.signal);
    const poly = new Polyline(r.points);
    routeLayer.clearLayers();
    routeBridgeLayer.clearLayers();
    L.polyline(r.points.map((p) => [p.lat, p.lon]), { className: 'route-line', weight: 7, interactive: false }).addTo(routeLayer);
    if (!silent) map.fitBounds(L.latLngBounds(r.points.map((p) => [p.lat, p.lon])), { padding: [40, 40] });
    state.route = poly;
    state.routeInfo = r;
    state.routeHint = null;
    state.offRouteCount = 0;
    state.routeBridges = [];
    state.arrived = false;
    $('route-panel').hidden = false;
    $('route-summary').textContent = `${fmtDist(r.distance)} · ${Math.round(r.duration / 60)} min`;
    $('route-remaining').textContent = '';
    $('route-count').textContent = 'lade …';

    state.fired = new Set([...state.fired].filter((k) => !k.startsWith('r')));
    await loadRouteBridges(poly, ctrl);
  } catch (e) {
    if (e.name === 'AbortError') return;
    setInfo(e.message || 'Fehler bei der Routenberechnung');
    console.warn(e);
  }
}

/* Bereits geladene Routenabschnitte (für Neuberechnungen wiederverwenden) */
const bridgeCache = new Map();
const loadedLines = [];

function isCovered(pts) {
  return pts.every((p) => loadedLines.some((l) => { const m = l.locateNear(p); return m && m.dist < 20; }));
}

const wait = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('abort'), { name: 'AbortError' })); }, { once: true });
});

/**
 * Brücken abschnittsweise laden. Jeder fertige Abschnitt erscheint sofort;
 * fehlgeschlagene Abschnitte (Server überlastet) werden mit wachsendem
 * Abstand automatisch erneut abgefragt.
 */
async function loadRouteBridges(poly, ctrl) {
  const chunks = routeChunks(poly.pts).map((pts) => {
    const a = poly.locateNear(pts[0]), b = poly.locateNear(pts[pts.length - 1]);
    return { pts, from: a ? a.along : 0, to: b ? b.along : poly.length, done: isCovered(pts) };
  });
  state.routeChunks = chunks;
  const n = chunks.length;
  const refresh = () => {
    if (state.route !== poly) return;
    // auch die Brücken aus der Umgebungssuche (freie Fahrt) mitverwenden
    const all = new Map([...state.bridges, ...bridgeCache]);
    computeGroups(all);
    state.routeBridgesAll = matchBridgesToRoute(all, poly);
    state.routeBridges = state.routeBridgesAll.filter(visible);
    drawRouteBridges();
    renderRouteList([], 'none');
    if (state.pos && state.tracking) onPosition({ ...state.pos, accuracy: null, speed: state.speed, heading: state.heading });
  };
  const report = (extra = '') => {
    const open = chunks.filter((c) => !c.done).length;
    const nConf = state.routeBridges.filter(conflict).length;
    const base = `${state.routeBridges.length} Brücken auf der Route${nConf ? ` – ${nConf} mit Einschränkung für Ihr Fahrzeug!` : ''}`;
    setInfo(open ? `${base} · ${n - open} von ${n} Abschnitten geladen${extra}` : base);
    $('route-missing').hidden = !open;
    if (open) {
      const first = chunks.find((c) => !c.done);
      $('route-missing').textContent = `⚠ Brückendaten ab km ${Math.floor(first.from / 1000)} noch unvollständig (${open} von ${n} Abschnitten fehlen)`;
    }
  };
  refresh();
  report();
  const DELAYS = [0, 10, 30, 60, 120, 180, 300, 300, 300, 300];
  for (let round = 0; round < DELAYS.length; round++) {
    const todo = chunks.filter((c) => !c.done);
    if (!todo.length) break;
    if (DELAYS[round]) {
      report(` – Server überlastet, neuer Versuch in ${DELAYS[round]} s`);
      await wait(DELAYS[round] * 1000, ctrl.signal);
    }
    for (const c of todo) {
      try {
        report(' …');
        await staticData.init();
        // In Deutschland aus den eigenen, vorab aufbereiteten Daten; sonst Overpass
        const res = staticData.available && c.pts.every((p) => staticData.covers(p))
          ? await staticData.bridgesNear(c.pts, 40)
          : await fetchBridgesAlongChunk(c.pts, 30, ctrl.signal, { attempts: 4 });
        for (const [id, b] of res) bridgeCache.set(id, b);
        c.done = true;
        loadedLines.push(new Polyline(c.pts));
        refresh();
      } catch (e) {
        if (e.name === 'AbortError') throw e;
      }
    }
  }
  report(chunks.some((c) => !c.done) ? ' – bitte später „Neu laden“ tippen' : '');
}

$('btn-reload').addEventListener('click', () => {
  if (state.dest) planRoute(state.dest, true);
});

function drawRouteBridges() {
  routeBridgeLayer.clearLayers();
  for (const b of state.routeBridges) {
    const w = conflict(b);
    for (const br of b.bridges) {
      L.polyline(br.geom.map((p) => [p.lat, p.lon]), { className: `bridge-route ${w ? 'danger' : ''} type-${b.type}`, weight: 8 })
        .bindPopup(popupHtml(b, br)).addTo(routeBridgeLayer);
    }
  }
}

function clearRoute() {
  state.abort?.abort();
  state.route = null;
  state.routeBridges = [];
  state.routeBridgesAll = null;
  state.dest = null;
  routeLayer.clearLayers();
  routeBridgeLayer.clearLayers();
  if (destMarker) map.removeLayer(destMarker);
  destMarker = null;
  $('route-panel').hidden = true;
  $('route-missing').hidden = true;
  $('dest-input').value = '';
  setInfo('Route gelöscht – freie Fahrt');
}

/* ---------------- Demo / Simulation ---------------- */
function startDemo(noRoute = false) {
  if (!state.route) { toast('Für die Demo zuerst ein Ziel suchen (oder lange auf die Karte tippen)'); return; }
  unlockAudio();
  if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  stopDemo();
  state.tracking = true;
  state.demoAlong = 0;
  state.demoNoRoute = noRoute;
  state.matchWayId = null;
  state.routeHint = 0;
  state.fired.clear();
  state.firedPoints = [];
  state.heading = null;
  state.headingRef = null;
  setFollow(true);
  const tick = 1000 / settings.demoFactor;
  state.demoTimer = setInterval(() => {
    const v = settings.demoSpeed / 3.6;
    state.demoAlong += v;
    if (state.demoAlong >= state.route.length) { toast('Demo beendet – Ziel erreicht'); stop(); return; }
    const p = state.route.pointAt(state.demoAlong);
    onPosition({ lat: p.lat, lon: p.lon, accuracy: 5, speed: v, heading: state.route.bearingAt(p.index) });
  }, tick);
  updateStartButton();
  map.setZoom(16);
}
function stopDemo() {
  state.demoNoRoute = false;
  if (state.demoTimer) clearInterval(state.demoTimer);
  state.demoTimer = null;
}

/* ---------------- Kleinkram ---------------- */
function setInfo(t) { $('info').textContent = t; }
function toast(t) {
  const el = $('toast');
  el.textContent = t;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 3500);
}
function log(t) {
  const li = document.createElement('li');
  li.textContent = `${new Date().toLocaleTimeString('de-DE')} – ${t}`;
  $('log').prepend(li);
  while ($('log').children.length > 30) $('log').lastChild.remove();
}

/* ---------------- UI-Verdrahtung ---------------- */
$('btn-start').addEventListener('click', () => (state.tracking ? stop() : start()));
$('btn-center').addEventListener('click', () => setFollow(true));
$('btn-demo').addEventListener('click', () => startDemo(false));
$('btn-demo-free').addEventListener('click', () => startDemo(true));
$('btn-clear-route').addEventListener('click', clearRoute);
$('btn-toggle-list').addEventListener('click', () => {
  const l = $('route-list');
  l.hidden = !l.hidden;
  $('btn-toggle-list').textContent = l.hidden ? 'Liste' : 'Ausblenden';
});

$('dest-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('dest-input').value.trim();
  if (!q) return;
  const box = $('dest-results');
  box.innerHTML = '<li class="muted">Suche …</li>';
  box.hidden = false;
  try {
    const near = state.pos || { lat: map.getCenter().lat, lon: map.getCenter().lng };
    const res = await geocode(q, near);
    if (!res.length) { box.innerHTML = '<li class="muted">Nichts gefunden</li>'; return; }
    box.innerHTML = res.map((r, i) => `<li data-i="${i}">${esc(r.label)}</li>`).join('');
    box.onclick = (ev) => {
      const li = ev.target.closest('li[data-i]');
      if (!li) return;
      const r = res[+li.dataset.i];
      box.hidden = true;
      $('dest-input').value = r.label.split(',')[0];
      setDestination(r);
    };
  } catch (err) {
    box.innerHTML = `<li class="muted">${esc(err.message)}</li>`;
  }
});

// Einstellungen
const dlg = $('settings');
$('btn-settings').addEventListener('click', () => {
  for (const [k, v] of Object.entries(settings)) {
    const el = dlg.querySelector(`[name="${k}"]`);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = v; else el.value = v;
  }
  dlg.showModal();
});
dlg.addEventListener('close', () => {
  if (dlg.returnValue !== 'save') return;
  for (const el of dlg.querySelectorAll('[name]')) {
    settings[el.name] = el.type === 'checkbox' ? el.checked : Number(el.value) || 0;
  }
  save('bridgeinfo.settings', settings);
  if (state.routeBridgesAll) state.routeBridges = state.routeBridgesAll.filter(visible);
  drawAreaBridges();
  drawRouteBridges();
  renderRouteList([], 'none');
  if (state.pos && state.tracking) onPosition({ ...state.pos, accuracy: null, speed: state.speed, heading: state.heading });
  toast('Einstellungen gespeichert');
});
$('btn-test').addEventListener('click', () => {
  unlockAudio();
  fireAlert({ type: 'over', name: 'Testbrücke', distance: settings.alertDistance, length: 350, height: 25, point: { lat: 0, lon: 0 } }, null);
});

// Service Worker (Offline-Start, „Zum Startbildschirm hinzufügen“)
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Vorab aufbereitete Daten (falls vorhanden) früh laden
staticData.init().then((m) => {
  if (!m) return;
  const d = new Date(m.osm_date || m.built);
  $('data-info').textContent = `Kartendaten Deutschland: Stand ${d.toLocaleDateString('de-DE')} (monatlich aktualisiert); Wohnstraßen und Ausland live`;
});

// Für Tests/Debugging
window.BridgeInfo = { state, settings, onPosition, planRoute, setDestination, startDemo, stop };

// Höhe des unteren Panels für die Positionierung der Buttons
new ResizeObserver(([e]) => {
  document.documentElement.style.setProperty('--sheet-h', `${Math.round(e.target.getBoundingClientRect().height)}px`);
}).observe($('sheet'));
