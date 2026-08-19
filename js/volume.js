import { MUSCLE_GROUPS } from './seed.js';
import { state, findExercise } from './store.js';
import { el } from './dom.js';

/**
 * Weekly set volume per muscle group, measured against what the templates
 * actually prescribe. Targets are derived rather than hardcoded so editing a
 * template moves its target with it — there's no second copy of the plan to
 * keep in sync.
 */

/** Monday 00:00 of the week containing `date` — the plan runs Mon–Sun. */
export function weekStart(date = new Date()) {
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // getDay(): 0 = Sunday
    return start;
}

/** Planned working sets per muscle group across one full week of templates. */
export function weeklyTargets() {
    const totals = new Map();

    for (const template of state.templates) {
        // Undefined counts as in-plan, so templates predating this flag keep
        // working; only an explicit opt-out is excluded.
        if (template.inWeeklyPlan === false) continue;

        for (const entry of template.exercises || []) {
            const muscle = findExercise(entry.exerciseId)?.muscleGroup;
            if (!muscle) continue;
            totals.set(muscle, (totals.get(muscle) || 0) + entry.sets);
        }
    }

    return totals;
}

/**
 * Working sets actually logged since Monday. Muscle group comes off the
 * workout entry's own snapshot rather than the library, so a session still
 * counts correctly for an exercise that's since been deleted or moved to a
 * different group. Only completed workouts are in `state.workouts`, so a
 * session in progress counts once it's finished.
 */
export function weeklyActual() {
    const totals = new Map();
    const since = weekStart().getTime();

    for (const workout of state.workouts) {
        if (new Date(workout.startedAt).getTime() < since) continue;

        for (const entry of workout.entries || []) {
            if (!entry.muscleGroup) continue;
            // Finishing already strips warm-ups; filtering again keeps older
            // and imported workouts honest too.
            const sets = entry.sets.filter((set) => !set.warmup).length;
            if (!sets) continue;
            totals.set(entry.muscleGroup, (totals.get(entry.muscleGroup) || 0) + sets);
        }
    }

    return totals;
}

function volumeRow(muscle, done, target) {
    const tracked = target > 0;
    const met = tracked && done >= target;
    const pct = tracked ? Math.min(100, Math.round((done / target) * 100)) : 100;

    return el('div', { class: 'volume-row' }, [
        el('div', { class: 'volume-row-top' }, [
            el('span', { class: 'volume-muscle' }, [
                el('span', { class: 'muscle-dot', dataset: { muscle } }),
                muscle,
            ]),
            el('span', {
                class: `volume-count${met ? ' met' : ''}${tracked ? '' : ' untracked'}`,
                text: tracked ? `${done} / ${target} sets` : `${done} sets · not in plan`,
            }),
        ]),
        el('div', { class: 'volume-bar' }, [
            el('div', {
                class: `volume-fill${met ? ' met' : ''}${tracked ? '' : ' untracked'}`,
                style: `width: ${pct}%`,
            }),
        ]),
    ]);
}

export function renderVolume(container) {
    const targets = weeklyTargets();
    const actual = weeklyActual();

    // Fixed muscle order everywhere, and only groups that are either
    // programmed or actually trained — an untouched group with no target is
    // just noise.
    const muscles = MUSCLE_GROUPS.filter((muscle) => targets.get(muscle) || actual.get(muscle));

    const start = weekStart();
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    const label = (date) => date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

    const section = el('div', { class: 'volume-section' }, [
        el('div', { class: 'volume-head' }, [
            el('span', { class: 'volume-title', text: 'This week’s volume' }),
            el('span', { class: 'volume-range', text: `${label(start)} – ${label(end)}` }),
        ]),
    ]);

    if (!muscles.length) {
        // "Build a template" is actively misleading when templates exist but
        // are all opted out — say which of the two situations this actually is.
        const excluded = state.templates.filter((template) => template.inWeeklyPlan === false).length;

        section.append(
            el('p', {
                class: 'hint',
                text: excluded
                    ? `No templates are counting toward the weekly plan (${excluded} opted out). Open one from Templates and switch “Counts toward weekly plan” to Yes.`
                    : 'Build a template — the sets it prescribes become this week’s target.',
            }),
        );
    } else {
        muscles.forEach((muscle) => section.append(volumeRow(muscle, actual.get(muscle) || 0, targets.get(muscle) || 0)));
    }

    container.append(section);
}
