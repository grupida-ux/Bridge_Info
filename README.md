# Brücken-Info

Web-App fürs Smartphone, die per GPS Standort und Fahrtrichtung erkennt und **in Echtzeit warnt, wenn eine Brücke vor Ihnen liegt** – per Sprachansage, Signalton, Vibration und Banner.

## Funktionen

- **Ohne Ziel („Straße folgen“):** Die App lädt das Straßennetz in Fahrtrichtung aus OpenStreetMap und ordnet Ihre Position der Straße zu, auf der Sie fahren. Dann folgt sie dieser Straße voraus, auch durch Kurven und über Kreuzungen, und bleibt dabei bevorzugt auf derselben Straßennummer bzw. demselben Namen. Gemeldet werden die Brücken auf diesem vorhergesagten Weg. Der Weg wird auf der Karte grün gestrichelt angezeigt. Die Vorausschau wächst mit der Geschwindigkeit (800 m bis 2,5 km). Biegen Sie ab, passt sich die Vorhersage sofort an. Kann die App keine Straße zuordnen, schaut sie ersatzweise geradeaus („Geradeaus“).
- **Route (mit Ziel):** Ziel suchen oder lange auf die Karte tippen. Die App berechnet eine Route (OSRM), lädt alle Brücken entlang der Strecke und zeigt eine Liste mit Entfernungen. Während der Fahrt wird Ihre Position auf die Route abgebildet, die Entfernung zur nächsten Brücke gilt dann entlang der Strecke (auch in Kurven). Verlassen Sie die Route, wird sie automatisch neu berechnet.
- **Überfahrt oder Unterführung:** Verläuft die Brücke in Ihrer Fahrtrichtung, fahren Sie darüber. Kreuzt sie Ihre Strecke, fahren Sie darunter durch. Parallel verlaufende Fuß-/Radwegbrücken werden ignoriert, die beiden Richtungsfahrbahnen einer Autobahnbrücke werden zu einer Meldung zusammengefasst.
- **Fahrzeughöhe/-gewicht:** In den Einstellungen eintragen. Ist eine Unterführung zu niedrig (`maxheight`) oder eine Brücke nicht tragfähig genug (`maxweight`), kommt eine frühere, rote Warnung (ab 1,5 km) und die Brücke ist auf der Karte rot markiert.
- **Demo-Modus:** Simuliert eine Fahrt entlang der geplanten Route (Geschwindigkeit und Zeitraffer einstellbar). **„Demo ohne Ziel“** fährt dieselbe Strecke ab, ohne dass die App die Route kennt. So lässt sich der Modus „Straße folgen“ testen.
- Bildschirm bleibt während der Fahrt an (Wake Lock), App ist als PWA installierbar.

## Benutzung

1. Seite öffnen (es muss **HTTPS** sein, sonst gibt der Browser kein GPS frei).
2. **Start** tippen und den Standortzugriff erlauben. Der erste Tipp schaltet auch Ton und Sprache frei.
3. Optional ein Ziel eingeben und **Route** tippen.
4. Über ⚙ stellen Sie ein, wie früh angesagt wird (200 m bis 1,5 km), welche Maße Ihr Fahrzeug hat und welche Warnarten aktiv sind. Mit „Warnung testen“ prüfen Sie die Ansage.

Tipp fürs Handy: Im Browser-Menü „Zum Startbildschirm hinzufügen“ wählen, dann startet die App im Vollbild.

## Veröffentlichen (GitHub Pages)

Die App besteht nur aus statischen Dateien. GitHub Pages ist auf „Deploy from a branch“ mit `main` und `/ (root)` eingestellt. Jeder Push auf `main` wird automatisch veröffentlicht unter `https://grupida-ux.github.io/Bridge_Info/`.

Lokal testen: `python3 -m http.server 8000` und `http://localhost:8000` öffnen (localhost zählt als sicher, GPS funktioniert also).

## Aufbau

| Datei | Inhalt |
|---|---|
| `index.html`, `css/style.css` | Oberfläche (Karte, Panel, Einstellungen) |
| `js/app.js` | Ortung, Fahrtrichtung, Modi, Warnlogik, Demo |
| `js/roads.js` | Straßennetz laden, Map-Matching, dem Straßenverlauf vorausfolgen |
| `js/bridges.js` | Overpass-Abfragen, Brücken-Erkennung voraus, Abgleich mit der Route |
| `js/geo.js` | Geometrie: Distanzen, Kurse, Map-Matching mit Gitter-Index |
| `js/route.js` | Zielsuche (Nominatim) und Routing (OSRM) |
| `js/alerts.js` | Sprachausgabe, Signalton, Vibration |
| `sw.js`, `manifest.webmanifest` | Offline-Start / Installation als App |

## Grenzen

- **Datenqualität:** Alle Brückendaten stammen aus OpenStreetMap. Fehlt eine Brücke dort oder ist keine Durchfahrtshöhe eingetragen, kann die App nicht warnen. **Verkehrszeichen haben immer Vorrang.**
- **Ohne Ziel** nimmt die App an, dass Sie der Straße folgen. Biegen Sie ab, kann die Ansage einer Brücke kommen, die Sie dann nicht überfahren. Eine Brücke direkt nach einer Abzweigung wird erst nach dem Abbiegen erkannt.
- **Hintergrund:** Browser liefern GPS nur, solange die Seite sichtbar ist. Lassen Sie die App während der Fahrt im Vordergrund; die App hält den Bildschirm wach.
- Es werden die öffentlichen, kostenlosen Dienste von OpenStreetMap (Kacheln, Overpass, Nominatim) und OSRM genutzt. Für privaten Gebrauch passt das. Wer die App vielen Nutzern anbietet, sollte eigene oder kommerzielle Instanzen verwenden.

Daten © OpenStreetMap-Mitwirkende, ODbL.
