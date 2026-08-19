import { state, findExercise } from './store.js';
import { $, el, clear } from './dom.js';
import { formatWeight, getUnit, toDisplay } from './units.js';

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

/**
 * Epley (weight × (1 + reps/30)), fed *effective* reps — logged reps plus the
 * RIR left in the tank, since a set stopped 2 short predicts a heavier max
 * than the same set taken to failure.
 *
 * Above ~12 effective reps the formula drifts badly high, so those sets are
 * left out entirely rather than quietly reported: a "1RM" extrapolated from a
 * 20-rep calf raise is noise, and no estimate beats a wrong one.
 */
const MAX_EFFECTIVE_REPS = 12;

/** Whole units only — "101.33 kg" would imply precision an estimate lacks. */
function formatEstimate(kg) {
    return `${Math.round(toDisplay(kg))} ${getUnit()}`;
}

function estimateOneRepMax(set) {
    const effectiveReps = set.reps + (set.rir ?? 0);
    if (!(set.weightKg > 0) || effectiveReps < 1 || effectiveReps > MAX_EFFECTIVE_REPS) return null;
    return set.weightKg * (1 + effectiveReps / 30);
}

/**
 * Best estimated 1RM per exercise. Kept separate from computeRecords because
 * the two can come from different sets — a lighter set for more reps often
 * predicts a higher max than your heaviest single.
 */
export function computeOneRepMaxes() {
    const best = new Map();

    for (const workout of state.workouts) {
        for (const entry of workout.entries || []) {
            for (const set of entry.sets) {
                if (!set.done) continue;

                const estimateKg = estimateOneRepMax(set);
                if (estimateKg === null) continue;

                const current = best.get(entry.exerciseId);
                if (!current || estimateKg > current.estimateKg) {
                    best.set(entry.exerciseId, {
                        estimateKg,
                        weightKg: set.weightKg,
                        reps: set.reps,
                        rir: set.rir ?? 0,
                    });
                }
            }
        }
    }

    return best;
}

function recordCard(record, estimate) {
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
        estimate
            ? el('div', { class: 'pr-estimate' }, [
                  el('span', { class: 'pr-estimate-label', text: 'Est. 1RM' }),
                  el('span', { class: 'pr-estimate-value', text: formatEstimate(estimate.estimateKg) }),
                  // Always name the source set — it's what makes the number
                  // readable, especially when RIR pushed it above the top set.
                  el('span', {
                      class: 'pr-estimate-source',
                      text: `from ${formatWeight(estimate.weightKg)} × ${estimate.reps}${estimate.rir ? ` @ ${estimate.rir} RIR` : ''}`,
                  }),
              ])
            : null,
    ]);
}

export function renderRecords() {
    const container = clear($('#prs-body'));
    const records = [...computeRecords().values()].sort((a, b) => a.exerciseName.localeCompare(b.exerciseName));
    const estimates = computeOneRepMaxes();

    if (!records.length) {
        container.append(
            el('div', { class: 'empty-state' }, [
                el('p', { text: 'No records yet.' }),
                el('p', { class: 'hint', text: 'Log a set with weight and finish a workout — your heaviest lift per exercise shows up here.' }),
            ]),
        );
        return;
    }

    container.append(
        el('div', { class: 'stack' }, records.map((record) => recordCard(record, estimates.get(record.exerciseId)))),
    );
}
