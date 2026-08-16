import { $ } from './dom.js';
import { formatClock } from './units.js';
import { playRestOver } from './sfx.js';

// The timer is driven by a deadline timestamp, never by decrementing a
// counter. Backgrounded tabs get their intervals throttled hard (iOS clamps
// them to once a second or stops them entirely), so a counting-down variable
// drifts badly across a 3-minute rest. Reading `endsAt - Date.now()` on each
// paint means the displayed time is correct however long we were frozen.

let endsAt = 0;
let ticker = null;
let finished = false;

const bar = () => $('#rest-bar');

function paint() {
    const remaining = (endsAt - Date.now()) / 1000;

    if (remaining <= 0 && !finished) {
        finished = true;
        $('#rest-countdown').textContent = '0:00';
        $('#rest-label').textContent = 'Rest over';
        bar().classList.add('finished');
        playRestOver();
        // Leave it up briefly so a glance at the phone still shows why it buzzed.
        setTimeout(() => { if (finished) stopRest(); }, 6000);
        return;
    }
    if (finished) return;

    $('#rest-countdown').textContent = formatClock(remaining);
}

export function isResting() {
    return ticker !== null;
}

export function startRest(seconds) {
    if (!seconds || seconds <= 0) return;

    clearInterval(ticker);
    endsAt = Date.now() + seconds * 1000;
    finished = false;

    const node = bar();
    node.hidden = false;
    node.classList.remove('finished');
    $('#rest-label').textContent = 'Rest';

    paint();
    ticker = setInterval(paint, 250);
}

export function stopRest() {
    clearInterval(ticker);
    ticker = null;
    finished = false;
    const node = bar();
    node.hidden = true;
    node.classList.remove('finished');
}

export function adjustRest(deltaSeconds) {
    if (!isResting()) return;
    // Adjusting after the buzzer restarts the countdown from the delta rather
    // than from an already-negative deadline.
    endsAt = Math.max(Date.now(), finished ? Date.now() : endsAt) + deltaSeconds * 1000;
    if (endsAt <= Date.now()) {
        stopRest();
        return;
    }
    finished = false;
    bar().classList.remove('finished');
    $('#rest-label').textContent = 'Rest';
    paint();
}

export function initTimer() {
    $('#rest-minus').addEventListener('click', () => adjustRest(-15));
    $('#rest-plus').addEventListener('click', () => adjustRest(30));
    $('#rest-skip').addEventListener('click', stopRest);

    // A throttled/suspended interval can be stale by several seconds after
    // the tab was backgrounded; repaint at once on refocus.
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && isResting()) paint();
    });
}
