import { database } from './db.js';
import { state, loadWorkouts } from './store.js';
import { $, el, clear, openModal, closeModal, confirmSheet, toast } from './dom.js';
import { formatWeight, formatDuration } from './units.js';
import { computeRecords } from './records.js';
import { renderVolume } from './volume.js';
import { renderCheckin } from './checkin.js';

let onChanged = null;

function workoutVolume(workout) {
    return workout.entries.reduce(
        (sum, entry) => sum + entry.sets.reduce((v, set) => v + set.weightKg * set.reps, 0),
        0,
    );
}

function workoutSetCount(workout) {
    return workout.entries.reduce((sum, entry) => sum + entry.sets.length, 0);
}

function dayLabel(dateStr) {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    if (dateStr === today) return 'Today';
    if (dateStr === yesterday) return 'Yesterday';
    return new Date(`${dateStr}T00:00`).toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
    });
}

function renderSummary(container) {
    const weekAgo = Date.now() - 7 * 86400000;
    const thisWeek = state.workouts.filter((w) => new Date(w.startedAt).getTime() >= weekAgo).length;
    const totalVolume = state.workouts.reduce((sum, w) => sum + workoutVolume(w), 0);

    const tile = (value, label) =>
        el('div', { class: 'summary-tile' }, [
            el('div', { class: 'summary-value', text: value }),
            el('div', { class: 'summary-label', text: label }),
        ]);

    container.append(
        el('div', { class: 'summary-row' }, [
            tile(String(state.workouts.length), 'Workouts'),
            tile(String(thisWeek), 'This week'),
            tile(formatWeight(totalVolume), 'Total volume'),
        ]),
    );
}

function workoutCard(workout) {
    const time = new Date(workout.startedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const duration = workout.finishedAt
        ? formatDuration(new Date(workout.finishedAt) - new Date(workout.startedAt))
        : '—';

    return el('button', { class: 'card', type: 'button', dataset: { id: workout.id } }, [
        el('div', { class: 'card-title', text: workout.name }),
        el('div', {
            class: 'card-meta',
            text: `${time} · ${duration} · ${workoutSetCount(workout)} sets · ${formatWeight(workoutVolume(workout))}`,
        }),
        el('div', {
            class: 'card-preview',
            text: workout.entries.map((entry) => entry.exerciseName).join(' • '),
        }),
    ]);
}

export function renderHistory() {
    const body = clear($('#history-body'));

    renderSummary(body);
    // Shown even with nothing logged — an empty week against real targets is
    // itself the useful reading.
    renderVolume(body);
    renderCheckin(body);

    if (!state.workouts.length) {
        body.append(
            el('div', { class: 'empty-state' }, [
                el('p', { text: 'No workouts finished yet.' }),
                el('p', { class: 'hint', text: 'Finish a session from Today and it shows up here.' }),
            ]),
        );
        return;
    }

    let currentDay = null;
    let dayStack = null;

    state.workouts.forEach((workout) => {
        if (workout.date !== currentDay) {
            currentDay = workout.date;
            body.append(el('div', { class: 'history-group-label', text: dayLabel(currentDay) }));
            dayStack = el('div', { class: 'stack' });
            body.append(dayStack);
        }
        dayStack.append(workoutCard(workout));
    });
}

function openDetail(workoutId) {
    const workout = state.workouts.find((w) => w.id === workoutId);
    if (!workout) return;

    $('#workout-detail-title').textContent = workout.name;
    const body = clear($('#workout-detail-body'));

    const when = new Date(workout.startedAt).toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
    });
    body.append(el('p', { class: 'hint', text: when }));

    workout.entries.forEach((entry) => {
        const block = el('div', { class: 'history-exercise' }, [
            el('div', { class: 'history-exercise-name' }, [
                entry.muscleGroup ? el('span', { class: 'muscle-dot', dataset: { muscle: entry.muscleGroup } }) : null,
                entry.exerciseName,
            ]),
        ]);

        if (entry.sets.length) {
            block.append(
                el(
                    'div',
                    { class: 'history-sets' },
                    entry.sets.map((set) => el('span', { class: 'history-set', text: `${formatWeight(set.weightKg)} × ${set.reps}` })),
                ),
            );
        }

        if (entry.note?.trim()) {
            block.append(el('div', { class: 'note-banner-text', text: `📌 ${entry.note.trim()}` }));
        }

        body.append(block);
    });

    const actions = clear($('#workout-detail-actions'));
    actions.append(
        el('button', {
            class: 'btn btn-danger btn-block',
            type: 'button',
            text: 'Delete Workout',
            onclick: () => deleteWorkout(workout),
        }),
    );

    openModal('workout-detail-modal');
}

async function deleteWorkout(workout) {
    // Only warn about losing a record if this workout is actually the
    // current holder for one of its exercises — otherwise the warning is
    // just false alarm on every delete.
    const records = computeRecords();
    const affectsRecord = workout.entries.some((entry) => records.get(entry.exerciseId)?.workoutId === workout.id);

    const message = affectsRecord
        ? `Delete “${workout.name}” from ${dayLabel(workout.date)}? This also removes a personal record set here.`
        : `Delete “${workout.name}” from ${dayLabel(workout.date)}?`;

    const ok = await confirmSheet({
        title: 'Delete workout',
        message,
        confirmLabel: 'Delete',
        danger: true,
    });
    if (!ok) return;

    await database.deleteWorkout(workout.id);
    await loadWorkouts();
    closeModal('workout-detail-modal');
    renderHistory();
    onChanged?.();
    toast('Workout deleted');
}

export function initHistory({ onHistoryChanged } = {}) {
    onChanged = onHistoryChanged;
    $('#history-body').addEventListener('click', (event) => {
        const card = event.target.closest('.card[data-id]');
        if (card) openDetail(card.dataset.id);
    });
}
