import { database } from './db.js';
import { state, loadCheckins } from './store.js';
import { $, el, clear, openModal, closeModal, confirmSheet, toast, noteField } from './dom.js';
import { stepper } from './stepper.js';
import { weekStart } from './volume.js';
import { computeRecords } from './records.js';
import { getUnit, toDisplay, fromDisplay, stepWeight, weightPrecision, formatNumber, formatWeight } from './units.js';

/**
 * The plan's weekly check-in: a handful of numbers reviewed once a week
 * rather than chased daily, plus the trend that actually drives decisions
 * ("only reduce calories after two consecutive weeks without progress").
 *
 * Sessions and new PRs aren't asked for — the app already knows them, and
 * re-typing what it can count is how a check-in stops getting filled in.
 */

// From the plan's fat-loss targets: roughly 0.3–0.6 kg down per week.
const LOSS_TARGET_KG = { min: 0.3, max: 0.6 };

let onSaved = null;
let draft = null;

/** Waist rides the weight unit rather than adding a second setting: kg → cm,
 *  lb → in. Stored in cm regardless, same principle as weight always in kg. */
function waistUnit() {
    return getUnit() === 'kg' ? 'cm' : 'in';
}

function waistToDisplay(cm) {
    return getUnit() === 'kg' ? cm : cm / 2.54;
}

function waistFromDisplay(value) {
    return getUnit() === 'kg' ? value : value * 2.54;
}

/** Monday of the current week, as the `YYYY-MM-DD` key a check-in is filed under. */
export function currentWeekId(date = new Date()) {
    const start = weekStart(date);
    const local = new Date(start.getTime() - start.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
}

export function checkinFor(weekId) {
    return state.checkins.find((entry) => entry.id === weekId) || null;
}

/** Check-ins newest first — the order they're read in. */
export function sortedCheckins() {
    return [...state.checkins].sort((a, b) => b.id.localeCompare(a.id));
}

/** What the app can count for a week, so it never has to be typed. */
export function derivedStats(weekId) {
    const start = new Date(`${weekId}T00:00`);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);

    const inWeek = (iso) => {
        const time = new Date(iso).getTime();
        return time >= start.getTime() && time < end.getTime();
    };

    const sessions = state.workouts.filter((workout) => inWeek(workout.startedAt)).length;
    const newRecords = [...computeRecords().values()].filter((record) => inWeek(record.date)).length;

    return { sessions, newRecords };
}

/**
 * Change in body weight against the most recent earlier check-in that
 * recorded one — not simply "last week", so a skipped week still gives a
 * usable comparison instead of a blank.
 */
export function weightTrend(weekId) {
    const current = checkinFor(weekId);
    if (!current || current.bodyWeightKg == null) return null;

    const previous = sortedCheckins().find(
        (entry) => entry.id < weekId && entry.bodyWeightKg != null,
    );
    if (!previous) return null;

    const deltaKg = current.bodyWeightKg - previous.bodyWeightKg;
    const lost = -deltaKg;

    return {
        deltaKg,
        fromId: previous.id,
        // Only judged against the plan's range when actually losing; a gain
        // or a hold isn't "off target" without knowing the current goal.
        onTarget: lost >= LOSS_TARGET_KG.min && lost <= LOSS_TARGET_KG.max,
    };
}

// --- Form ----------------------------------------------------------------

function metricField(labelText, control, hint) {
    return el('div', { class: 'stepper-field' }, [
        el('span', { class: 'stepper-label', text: labelText }),
        control,
        hint ? el('span', { class: 'checkin-hint', text: hint }) : null,
    ]);
}

/** A stepper whose value may legitimately be "not recorded" — blank stays
 *  blank rather than being coerced to a misleading zero. */
function optionalStepper(options, onValue) {
    const control = stepper({ ...options, onChange: (value) => onValue(value) });
    return control;
}

export function openCheckinForm(weekId = currentWeekId()) {
    const unit = getUnit();
    const existing = checkinFor(weekId);

    draft = existing
        ? { ...existing }
        : { id: weekId, bodyWeightKg: null, waistCm: null, steps: null, proteinG: null, sleepEnergy: null, note: '' };

    const start = new Date(`${weekId}T00:00`);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    const label = (date) => date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

    $('#checkin-form-title').textContent = existing ? 'Edit Check-In' : 'Weekly Check-In';
    $('#checkin-week').textContent = `${label(start)} – ${label(end)}`;
    $('#delete-checkin-btn').hidden = !existing;

    const body = clear($('#checkin-body'));
    const stats = derivedStats(weekId);

    body.append(
        el('div', { class: 'checkin-derived' }, [
            el('span', { text: `${stats.sessions} session${stats.sessions === 1 ? '' : 's'} logged` }),
            el('span', { text: '·' }),
            el('span', { text: `${stats.newRecords} new PR${stats.newRecords === 1 ? '' : 's'}` }),
        ]),
    );

    const bodyWeight = optionalStepper(
        {
            value: draft.bodyWeightKg == null ? 0 : toDisplay(draft.bodyWeightKg, unit),
            min: 0,
            max: 500,
            decimals: true,
            precision: weightPrecision(unit),
            label: 'body weight',
            onStep: (base, direction) => stepWeight(base, direction, true, unit),
        },
        (value) => { draft.bodyWeightKg = value > 0 ? fromDisplay(value, unit) : null; },
    );

    const waist = optionalStepper(
        {
            value: draft.waistCm == null ? 0 : Math.round(waistToDisplay(draft.waistCm) * 10) / 10,
            min: 0,
            max: 300,
            step: 0.5,
            decimals: true,
            precision: 1,
            label: 'waist',
        },
        (value) => { draft.waistCm = value > 0 ? waistFromDisplay(value) : null; },
    );

    const steps = optionalStepper(
        { value: draft.steps ?? 0, min: 0, max: 100000, step: 500, label: 'steps' },
        (value) => { draft.steps = value > 0 ? value : null; },
    );

    const protein = optionalStepper(
        { value: draft.proteinG ?? 0, min: 0, max: 500, step: 5, label: 'protein' },
        (value) => { draft.proteinG = value > 0 ? value : null; },
    );

    const sleep = optionalStepper(
        { value: draft.sleepEnergy ?? 0, min: 0, max: 10, label: 'sleep and energy' },
        (value) => { draft.sleepEnergy = value > 0 ? value : null; },
    );

    body.append(
        el('div', { class: 'stepper-grid' }, [
            metricField(`Body weight (${unit})`, bodyWeight, 'Average of 3+ morning weigh-ins'),
            metricField(`Waist (${waistUnit()})`, waist),
            metricField('Avg daily steps', steps, 'Target 8,000–10,000'),
            metricField('Avg protein (g)', protein, 'Target 150–170 g'),
            metricField('Sleep / energy (1–10)', sleep),
        ]),
        noteField({
            label: 'Notes',
            placeholder: 'e.g. sleep was poor Thu–Fri, knee felt fine all week',
            value: draft.note || '',
            onSave: (value) => { draft.note = value; },
        }),
        el('p', { class: 'hint footnote', text: 'Leave anything you didn’t track at zero — it’s recorded as blank, not as a real zero.' }),
    );

    openModal('checkin-modal');
}

async function submitCheckin() {
    await database.saveCheckin(draft);
    await loadCheckins();
    closeModal('checkin-modal');
    onSaved?.();
    toast('Check-in saved');
}

async function deleteCheckin() {
    const ok = await confirmSheet({
        title: 'Delete check-in',
        message: 'This removes the numbers recorded for that week.',
        confirmLabel: 'Delete',
        danger: true,
    });
    if (!ok) return;

    await database.deleteCheckin(draft.id);
    await loadCheckins();
    closeModal('checkin-modal');
    onSaved?.();
    toast('Check-in deleted');
}

// --- History card ---------------------------------------------------------

function statLine(label, value) {
    return el('div', { class: 'checkin-stat' }, [
        el('span', { class: 'checkin-stat-label', text: label }),
        el('span', { class: 'checkin-stat-value', text: value }),
    ]);
}

function trendText(trend) {
    if (!trend) return null;

    const magnitude = formatWeight(Math.abs(trend.deltaKg));
    const direction = trend.deltaKg < 0 ? 'down' : trend.deltaKg > 0 ? 'up' : 'level';
    const text = direction === 'level' ? 'No change since last check-in' : `${magnitude} ${direction} since last check-in`;

    return el('div', {
        class: `checkin-trend${trend.onTarget ? ' on-target' : ''}`,
        text: trend.onTarget ? `${text} — in the 0.3–0.6 kg target range` : text,
    });
}

export function renderCheckin(container) {
    const weekId = currentWeekId();
    const checkin = checkinFor(weekId);
    const stats = derivedStats(weekId);

    const section = el('div', { class: 'checkin-section' }, [
        el('div', { class: 'volume-head' }, [
            el('span', { class: 'volume-title', text: 'Weekly check-in' }),
            el('button', {
                class: 'link-btn',
                type: 'button',
                text: checkin ? 'Edit' : 'Log it',
                onclick: () => openCheckinForm(weekId),
            }),
        ]),
    ]);

    if (!checkin) {
        section.append(
            el('p', {
                class: 'hint',
                text: `Nothing recorded this week yet. ${stats.sessions} session${stats.sessions === 1 ? '' : 's'} logged so far.`,
            }),
        );
        container.append(section);
        return;
    }

    const unit = getUnit();
    const stack = el('div', { class: 'checkin-stats' });

    if (checkin.bodyWeightKg != null) stack.append(statLine('Body weight', formatWeight(checkin.bodyWeightKg)));
    if (checkin.waistCm != null) {
        stack.append(statLine('Waist', `${formatNumber(Math.round(waistToDisplay(checkin.waistCm) * 10) / 10)} ${waistUnit()}`));
    }
    if (checkin.steps != null) stack.append(statLine('Avg steps', checkin.steps.toLocaleString()));
    if (checkin.proteinG != null) stack.append(statLine('Avg protein', `${checkin.proteinG} g`));
    if (checkin.sleepEnergy != null) stack.append(statLine('Sleep / energy', `${checkin.sleepEnergy}/10`));
    stack.append(statLine('Sessions', String(stats.sessions)));

    section.append(stack);

    const trend = trendText(weightTrend(weekId));
    if (trend) section.append(trend);

    if (checkin.note?.trim()) {
        section.append(el('div', { class: 'note-banner-text', text: `📌 ${checkin.note.trim()}` }));
    }

    container.append(section);
}

export function initCheckin({ onCheckinChanged } = {}) {
    onSaved = onCheckinChanged;
    $('#checkin-save-btn').addEventListener('click', submitCheckin);
    $('#delete-checkin-btn').addEventListener('click', deleteCheckin);
}
