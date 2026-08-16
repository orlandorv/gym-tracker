import { state, findExercise } from './store.js';
import { $, el, clear } from './dom.js';
import { formatWeight } from './units.js';

/**
 * Heaviest logged set per exercise, across every completed workout. Ties on
 * weight break toward more reps (a heavier-feeling set at the same load),
 * then toward the more recent date.
 */
export function computeRecords() {
    const best = new Map();

    for (const workout of state.workouts) {
        for (const entry of workout.entries || []) {
            for (const set of entry.sets) {
                if (!set.done || !(set.weightKg > 0)) continue;

                const current = best.get(entry.exerciseId);
                const candidate = {
                    exerciseId: entry.exerciseId,
                    exerciseName: entry.exerciseName,
                    weightKg: set.weightKg,
                    reps: set.reps,
                    date: workout.startedAt,
                    workoutId: workout.id,
                };

                const better =
                    !current ||
                    candidate.weightKg > current.weightKg ||
                    (candidate.weightKg === current.weightKg &&
                        (candidate.reps > current.reps ||
                            (candidate.reps === current.reps && new Date(candidate.date) > new Date(current.date))));

                if (better) best.set(entry.exerciseId, candidate);
            }
        }
    }

    return best;
}

function recordCard(record) {
    const exercise = findExercise(record.exerciseId);
    const when = new Date(record.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

    return el('div', { class: 'card pr-card' }, [
        el('div', { class: 'pr-card-top' }, [
            el('div', {}, [
                el('div', { class: 'card-title', text: record.exerciseName }),
                exercise
                    ? el('div', { class: 'badge-row' }, [
                          el('span', { class: 'badge badge-muscle', text: exercise.muscleGroup, dataset: { muscle: exercise.muscleGroup } }),
                          el('span', { class: 'badge badge-equipment', text: exercise.equipment }),
                      ])
                    : el('div', { class: 'card-meta', text: 'Exercise removed from library' }),
            ]),
            el('div', { class: 'pr-weight' }, [
                el('div', { class: 'pr-weight-value', text: formatWeight(record.weightKg) }),
                el('div', { class: 'pr-weight-sub', text: `×${record.reps}` }),
            ]),
        ]),
        el('div', { class: 'pr-date', text: `Set on ${when}` }),
    ]);
}

export function renderRecords() {
    const container = clear($('#prs-body'));
    const records = [...computeRecords().values()].sort((a, b) => a.exerciseName.localeCompare(b.exerciseName));

    if (!records.length) {
        container.append(
            el('div', { class: 'empty-state' }, [
                el('p', { text: 'No records yet.' }),
                el('p', { class: 'hint', text: 'Log a set with weight and finish a workout — your heaviest lift per exercise shows up here.' }),
            ]),
        );
        return;
    }

    container.append(el('div', { class: 'stack' }, records.map(recordCard)));
}
