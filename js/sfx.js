// Every sound effect in the app shares one AudioContext, unlocked on the
// first tap of a session. iOS blocks audio before a user gesture, and by the
// time a sound actually needs to play (a set gets ticked, a rest ends), the
// tap that could have unlocked it is long gone — so this fires eagerly on
// the first pointerdown anywhere, not lazily at the moment a sound is needed.

let audioCtx = null;

function unlockAudio() {
    if (audioCtx) {
        if (audioCtx.state === 'suspended') audioCtx.resume();
        return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audioCtx = new Ctx();
    const source = audioCtx.createBufferSource();
    source.buffer = audioCtx.createBuffer(1, 1, 22050);
    source.connect(audioCtx.destination);
    source.start(0);
}

/** True when the device can actually buzz — iOS Safari cannot. */
export function canVibrate() {
    return typeof navigator.vibrate === 'function';
}

function ensureRunning() {
    if (!audioCtx) return false;
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return true;
}

/** A single short tone. `at` and `duration` are in seconds. */
function tone(freq, at, duration = 0.16, peak = 0.3) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    const start = audioCtx.currentTime + at;

    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, start);
    // Ramped rather than switched, so it doesn't click.
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(peak, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, start + duration);

    osc.connect(gain).connect(audioCtx.destination);
    osc.start(start);
    osc.stop(start + duration + 0.02);
}

/** Rest timer hitting zero — three insistent beeps, plus a buzz where supported. */
export function playRestOver() {
    if (!ensureRunning()) return;
    [0, 0.28, 0.56].forEach((at) => tone(880, at, 0.22, 0.35));
    if (canVibrate()) navigator.vibrate([300, 120, 300]);
}

/**
 * A set ticked off. This can fire 15-30+ times in one workout, so it stays
 * quiet and quick — a soft two-note blip meant to fade into the background,
 * not announce itself the way the rest-over alarm does.
 */
export function playSetComplete() {
    if (!ensureRunning()) return;
    tone(660, 0, 0.09, 0.18);
    tone(988, 0.05, 0.12, 0.16);
}

/**
 * Finishing a workout. Fires once per session, so unlike the set sound it
 * can afford to be a bit more present — a short major-triad rise (C5-E5-G5).
 */
export function playWorkoutFinished() {
    if (!ensureRunning()) return;
    tone(523.25, 0, 0.2, 0.28);
    tone(659.25, 0.12, 0.2, 0.28);
    tone(783.99, 0.24, 0.34, 0.3);
}

export function initSfx() {
    document.addEventListener('pointerdown', unlockAudio, { once: true });
}
