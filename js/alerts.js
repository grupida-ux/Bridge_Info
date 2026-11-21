// Warnausgabe: Sprache, Ton, Vibration
let audioCtx = null;

/** Muss aus einer Nutzeraktion heraus aufgerufen werden (Autoplay-Regeln) */
export function unlockAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* kein Audio verfügbar */ }
  try {
    // iOS: Sprachausgabe einmal mit leerem Text "freischalten"
    if ('speechSynthesis' in window) speechSynthesis.speak(new SpeechSynthesisUtterance(''));
  } catch { /* ignorieren */ }
}

export function beep(urgent = false) {
  if (!audioCtx) return;
  const tones = urgent ? [880, 660, 880, 660] : [740, 990];
  let t = audioCtx.currentTime + 0.02;
  for (const f of tones) {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    o.connect(g).connect(audioCtx.destination);
    o.start(t);
    o.stop(t + 0.2);
    t += 0.22;
  }
}

let germanVoice = null;
function pickVoice() {
  const voices = speechSynthesis.getVoices();
  germanVoice = voices.find((v) => v.lang?.toLowerCase().startsWith('de')) || null;
}
if ('speechSynthesis' in window) {
  pickVoice();
  speechSynthesis.addEventListener?.('voiceschanged', pickVoice);
}

export function speak(text) {
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'de-DE';
  if (germanVoice) u.voice = germanVoice;
  u.rate = 1.05;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

export function vibrate(urgent = false) {
  try { navigator.vibrate?.(urgent ? [300, 120, 300, 120, 300] : [200, 100, 200]); } catch { /* ignorieren */ }
}
