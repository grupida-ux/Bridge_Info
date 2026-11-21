// Zielsuche (Nominatim) und Routenberechnung (OSRM)
export async function geocode(query, near, signal) {
  const params = new URLSearchParams({ q: query, format: 'jsonv2', limit: '5', 'accept-language': 'de' });
  if (near) {
    const d = 1.5;
    params.set('viewbox', `${near.lon - d},${near.lat + d},${near.lon + d},${near.lat - d}`);
  }
  const res = await fetch('https://nominatim.openstreetmap.org/search?' + params, { signal });
  if (!res.ok) throw new Error('Adresssuche fehlgeschlagen');
  const arr = await res.json();
  return arr.map((r) => ({ lat: +r.lat, lon: +r.lon, label: r.display_name }));
}

export async function route(from, to, signal) {
  const url = `https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson&steps=false`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error('Routenberechnung fehlgeschlagen');
  const json = await res.json();
  if (json.code !== 'Ok' || !json.routes?.length) throw new Error('Keine Route gefunden');
  const r = json.routes[0];
  return {
    points: r.geometry.coordinates.map(([lon, lat]) => ({ lat, lon })),
    distance: r.distance,
    duration: r.duration,
  };
}
