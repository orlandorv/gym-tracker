import { database, DEFAULTS, uid } from './db.js';

import { state, loadWorkouts, findExercise, lastPerformance, lastNote } from './store.js';
import { $, el, clear, confirmSheet, toast, noteField } from './dom.js';
import { stepper } from './stepper.js';
import { openPicker } from './picker.js';
import { openPlateCalculator } from './plates.js';
import { startRest, stopRest, isResting } from './timer.js';
import { canVibrate, playSetComplete, playWorkoutFinished } from './sfx.js';
import { getUnit, toDisplay, fromDisplay, stepWeight, weightPrecision, formatNumber, formatWeight, formatDuration, formatStopwatch } from './units.js';

let session = null;
let wakeLock = null;
let onFinished = null;
let bannerSub = null;
let elapsedEl = null;
let elapsedInterval = null;
let timerPaused = false;
let exercisesStack = null;

// --- Wake lock -----------------------------------------------------------

async function acquireWakeLock() {
    if (!('wakeLock' in navigator) || wakeLock) return;
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch {
        // Denied or unsupported — the screen just sleeps as usual.
    }
}

function releaseWakeLock() {
    wakeLock?.release().catch(() => {});
    wakeLock = null;
}

// --- Elapsed-time stopwatch ------------------------------------------------
// Runs off real timestamps (Date.now() - startedAt) rather than a decrementing
// counter, same reasoning as the rest timer: a backgrounded tab throttles
// setInterval, so only wall-clock math stays accurate through that.

// Warm-up sets are excluded from every headline count (this, the summary
// banner, "all done" pausing, PRs) — they're a ramp-up, not logged training
// volume, same as the plan's own "do one lighter set before the first heavy
// lift" rule.
function allSetsDone() {
    if (!session) return false;
    const total = session.entries.reduce((sum, e) => sum + e.sets.filter((s) => !s.warmup).length, 0);
    if (total === 0) return false; // nothing to finish yet — don't show "done"
    const done = session.entries.reduce((sum, e) => sum + e.sets.filter((s) => !s.warmup && s.done).length, 0);
    return done === total;
}

function tickElapsed() {
    if (!session || !elapsedEl) return;
    elapsedEl.textContent = formatStopwatch(Date.now() - new Date(session.startedAt));
}

function stopElapsedTicker() {
    clearInterval(elapsedInterval);
    elapsedInterval = null;
}

/**
 * Re-checks whether every set is ticked and pauses/resumes the ticking clock
 * to match. Called after anything that can change the done/total count —
 * ticking a set, adding or removing one.
 */
function syncElapsedTimer() {
    if (!session || !elapsedEl) return;
    timerPaused = allSetsDone();
    elapsedEl.closest('.workout-timer')?.classList.toggle('paused', timerPaused);

    stopElapsedTicker();
    tickElapsed(); // freeze/resume from the exact moment, not the next 1s tick
    if (!timerPaused) {
        elapsedInterval = setInterval(tickElapsed, 1000);
    }
}

// --- Session lifecycle ---------------------------------------------------

function entryFromTemplate(templateEntry) {
    const exercise = findExercise(templateEntry.exerciseId);
    const previous = lastPerformance(templateEntry.exerciseId);
    const previousSets = previous?.sets ?? [];
    // Each set remembers its own weight from last time — set 1 seeds from
    // last time's set 1, set 2 from set 2, and so on, rather than copying
    // whatever the final set happened to be onto every row. A set beyond
    // what you logged last time (e.g. you added one to the template since)
    // falls back to the last known weight instead of dropping to zero.
    const lastKnownWeight = previousSets.at(-1)?.weightKg ?? 0;
    // What you actually hit last time beats the template's static target,
    // which itself beats the flat app-wide default.
    const seedRir = previousSets.at(-1)?.rir ?? templateEntry.rir ?? DEFAULTS.rir;

    return {
        exerciseId: templateEntry.exerciseId,
        exerciseName: exercise?.name || 'Unknown exercise',
        muscleGroup: exercise?.muscleGroup || '',
        attachment: exercise?.attachment || '',
        equipment: exercise?.equipment || '',
        restSeconds: templateEntry.restSeconds,
        targetReps: templateEntry.reps,
        // Snapshotted at session start, same as targetReps — the fixed bar
        // "ready to progress" checks every set against, independent of
        // whatever set.rir gets edited to mid-session.
        targetRir: templateEntry.rir ?? DEFAULTS.rir,
        note: '',
        sets: Array.from({ length: templateEntry.sets }, (_, i) => ({
            reps: templateEntry.reps,
            weightKg: previousSets[i]?.weightKg ?? lastKnownWeight,
            rir: previousSets[i]?.rir ?? seedRir,
            done: false,
            completedAt: null,
        })),
    };
}

function entryFromExercise(exerciseId) {
    return entryFromTemplate({ exerciseId, ...DEFAULTS });
}

async function persist() {
    if (!session) return;
    await database.saveWorkout(session);
}

export async function startWorkout(templateId = null) {
    if (session) {
        toast('Finish or discard the current workout first');
        return;
    }

    const template = templateId ? state.templates.find((t) => t.id === templateId) : null;
    const now = new Date();

    session = {
        id: uid(),
        status: 'active',
        date: now.toISOString().slice(0, 10),
        startedAt: now.toISOString(),
        finishedAt: null,
        templateId: template?.id || null,
        name: template?.name || 'Quick Workout',
        entries: (template?.exercises || []).map(entryFromTemplate),
    };

    await persist();
    acquireWakeLock();
    render();
    document.querySelector('[data-tab="today"]').click();
}

export async function resumeActive() {
    session = state.activeWorkout;
    if (session) acquireWakeLock();
}

async function finishWorkout() {
    const doneSets = session.entries.reduce((sum, entry) => sum + entry.sets.filter((s) => !s.warmup && s.done).length, 0);
    // A note ("shoulder twinged, skipped it") is worth keeping even with
    // nothing ticked — only offer to discard when there's truly nothing to save.
    const hasNote = session.entries.some((entry) => entry.note?.trim());

    if (doneSets === 0 && !hasNote) {
        const discard = await confirmSheet({
            title: 'Nothing logged',
            message: 'No sets were ticked off. Discard this workout instead?',
            confirmLabel: 'Discard',
            danger: true,
        });
        if (discard) await discardWorkout(true);
        return;
    }

    const ok = await confirmSheet({
        title: 'Finish workout',
        message:
            doneSets > 0
                ? `${doneSets} set${doneSets > 1 ? 's' : ''} logged. Anything left unticked is dropped.`
                : 'No sets were ticked off, but your notes will be saved.',
        confirmLabel: 'Finish',
    });
    if (!ok) return;

    // Keep only what was actually performed, so history reads as a record of
    // work done rather than of work planned — but never drop an exercise you
    // left a note on ("shoulder twinged, skipped it" is worth keeping). Warm-up
    // sets never make the cut either way — they're a ramp-up, not logged
    // training volume, so History and Records only ever see working sets.
    session.entries = session.entries
        .map((entry) => ({ ...entry, sets: entry.sets.filter((s) => s.done && !s.warmup) }))
        .filter((entry) => entry.sets.length > 0 || entry.note?.trim());
    session.status = 'completed';
    session.finishedAt = new Date().toISOString();

    await database.saveWorkout(session);
    session = null;
    stopRest();
    releaseWakeLock();
    await loadWorkouts();
    render();
    onFinished?.();
    playWorkoutFinished();
    toast('Workout saved');
}

async function discardWorkout(skipConfirm = false) {
    if (!skipConfirm) {
        const ok = await confirmSheet({
            title: 'Discard workout',
            message: 'This deletes the session and everything logged in it.',
            confirmLabel: 'Discard',
            danger: true,
        });
        if (!ok) return;
    }
    await database.deleteWorkout(session.id);
    session = null;
    stopRest();
    releaseWakeLock();
    await loadWorkouts();
    render();
    toast('Workout discarded');
}

// --- Set rows ------------------------------------------------------------

function ghostText(exerciseId) {
    const previous = lastPerformance(exerciseId);
    if (!previous) return null;
    const summary = previous.sets
        .slice(0, 4)
        .map((set) => `${formatNumber(toDisplay(set.weightKg))}×${set.reps}`)
        .join('  ');
    const when = new Date(previous.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return `Last time (${when}):  ${summary}`;
}

/**
 * Free-text reminder for the next session ("go up to 75", "left shoulder
 * twinged on set 3"). Saved with the workout and shown back on this exercise
 * next time — at the machine, where it's actionable.
 */
function noteSection(entry) {
    let saveTimer = null;

    const field = el('textarea', {
        class: 'form-input note-input',
        rows: 2,
        placeholder: 'e.g. go up to 75 next time',
        value: entry.note || '',
        hidden: !entry.note,
    });

    const addLink = el('button', {
        class: 'link-btn',
        type: 'button',
        text: '+ Note for next time',
        hidden: Boolean(entry.note),
    });

    addLink.addEventListener('click', () => {
        field.hidden = false;
        addLink.hidden = true;
        field.focus();
    });

    field.addEventListener('input', () => {
        entry.note = field.value;
        // Debounced: a write per keystroke would hammer IndexedDB for no gain.
        clearTimeout(saveTimer);
        saveTimer = setTimeout(persist, 500);
    });

    field.addEventListener('blur', () => {
        clearTimeout(saveTimer);
        entry.note = field.value;
        persist();
        if (!field.value.trim()) {
            field.hidden = true;
            addLink.hidden = false;
        }
    });

    return el('div', { class: 'note-section' }, [addLink, field]);
}

/**
 * Double progression, per the plan: once every working set reaches the top
 * of its rep range while still at (or above) the intended RIR — not by
 * grinding past it — it's time to add weight rather than repeat the same
 * numbers next session.
 */
/** Seeds the plate calculator with the top working set — the one you'd
 *  actually be loading the bar for. */
function heaviestWorkingWeight(entry) {
    return entry.sets.reduce((max, set) => (set.warmup ? max : Math.max(max, set.weightKg)), 0);
}

function isReadyToProgress(entry) {
    const working = entry.sets.filter((s) => !s.warmup);
    if (!working.length || !Number.isFinite(entry.targetReps)) return false;
    return working.every((s) => s.done && s.reps >= entry.targetReps && s.rir >= (entry.targetRir ?? 0));
}

function carriedNote(entry) {
    const previous = lastNote(entry.exerciseId);
    if (!previous) return null;

    const when = new Date(previous.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

    const dismiss = el('button', {
        class: 'note-done',
        type: 'button',
        'aria-label': 'Mark note as done',
        text: '✓',
        onclick: async () => {
            // Flag it on the workout it came from, so it stops surfacing without
            // erasing the record of what you wrote.
            const source = await database.getWorkoutById(previous.workoutId);
            const sourceEntry = source?.entries.find((e) => e.exerciseId === entry.exerciseId);
            if (sourceEntry) {
                sourceEntry.noteDone = true;
                await database.saveWorkout(source);
                await loadWorkouts();
            }
            banner.remove();
            toast('Note cleared');
        },
    });

    const banner = el('div', { class: 'note-banner' }, [
        el('span', { class: 'note-pin', text: '📌' }),
        el('div', { class: 'note-banner-body' }, [
            el('div', { class: 'note-banner-label', text: `Note from ${when}` }),
            el('div', { class: 'note-banner-text', text: previous.note }),
        ]),
        dismiss,
    ]);

    return banner;
}

function setRow(entry, set, index, label, refreshSets, refreshProgress) {
    const unit = getUnit();

    const repsStepper = stepper({
        value: set.reps,
        min: 1, // a logged set can't have zero reps
        max: 999,
        label: 'reps',
        className: 'stepper-set',
        onChange: (value) => { set.reps = value; updateBanner(); refreshProgress(); persist(); },
    });

    const weightStepper = stepper({
        value: toDisplay(set.weightKg, unit),
        min: 0,
        max: 2000,
        label: 'weight',
        decimals: true,
        precision: weightPrecision(unit),
        className: 'stepper-set',
        onStep: (base, direction) => stepWeight(base, direction, false, unit),
        onChange: (value) => { set.weightKg = fromDisplay(value, unit); updateBanner(); persist(); },
    });

    // RIR ("approximate RIR" per set, per the plan) doesn't apply to warm-ups
    // — they're a ramp-up, not a working set — so that column stays a plain
    // dash there instead of a control.
    const rirCell = set.warmup
        ? el('div', { class: 'set-rir-empty', text: '–' })
        : stepper({
              value: set.rir ?? DEFAULTS.rir,
              min: 0,
              max: 10,
              label: 'RIR',
              className: 'stepper-compact',
              onChange: (value) => { set.rir = value; refreshProgress(); persist(); },
          });

    const check = el('button', {
        class: `set-check${set.done ? ' done' : ''}`,
        type: 'button',
        'aria-label': `Mark set ${label} done`,
        text: '✓',
    });

    // The index cell doubles as the delete control while the block is in edit
    // mode. A permanent delete column doesn't fit at 375px — it squeezes the
    // weight value down to ~28px, which clips "42.5". Warm-up sets get a
    // "W1, W2…" label, numbered separately from the working sets.
    const indexCell = el('div', { class: 'set-index-cell' }, [
        el('span', { class: `set-index${set.warmup ? ' set-index-warmup' : ''}`, text: label }),
        el('button', {
            class: 'set-remove',
            type: 'button',
            'aria-label': `Remove set ${label}`,
            text: '×',
            onclick: () => removeSet(entry, index, label, refreshSets),
        }),
    ]);

    const row = el('div', { class: `set-row${set.done ? ' done' : ''}${set.warmup ? ' set-row-warmup' : ''}` }, [
        indexCell,
        repsStepper,
        weightStepper,
        rirCell,
        check,
    ]);

    check.addEventListener('click', () => {
        set.done = !set.done;
        set.completedAt = set.done ? new Date().toISOString() : null;
        // Toggle in place rather than re-rendering, so the list doesn't jump
        // under your thumb and other rows keep any half-typed values.
        row.classList.toggle('done', set.done);
        check.classList.toggle('done', set.done);
        updateBanner();
        syncElapsedTimer();
        refreshProgress();
        persist();

        if (set.done) {
            playSetComplete();
            // Warm-ups are a ramp-up, not a working set — no need to eat into
            // your session standing around a rest timer built for the real sets.
            if (!set.warmup) startRest(entry.restSeconds);
        } else if (isResting()) {
            stopRest();
        }
    });

    return row;
}

async function removeSet(entry, index, label, refreshSets) {
    if (entry.sets.length <= 1) {
        toast('That’s the last set — remove the exercise instead');
        return;
    }

    // Ticked sets are work you actually did; don't let a stray tap erase it.
    if (entry.sets[index].done) {
        const ok = await confirmSheet({
            title: 'Discard logged set',
            message: `Set ${label} of ${entry.exerciseName} is already ticked off. Discard it?`,
            confirmLabel: 'Discard',
            danger: true,
        });
        if (!ok) return;
    }

    entry.sets.splice(index, 1);
    await persist();
    refreshSets();
    updateBanner();
    syncElapsedTimer();
    toast('Set removed');
}

// --- Drag to reorder -------------------------------------------------------
// A minimal FLIP-style sortable: the dragged block follows the pointer via a
// transform recomputed fresh every move (so it stays correct through however
// many DOM swaps happen mid-drag, with no cumulative offset math to get
// wrong); whichever sibling it crosses gets a one-shot slide animation into
// its vacated spot. On release the final DOM order is written back into
// session.entries and a normal render() gives every block fresh, correct
// index-bound handlers again.

/** The block's top position with no drag transform applied, for re-anchoring. */
function naturalTop(block) {
    const prev = block.style.transform;
    block.style.transform = 'none';
    const top = block.getBoundingClientRect().top;
    block.style.transform = prev;
    return top;
}

/** Slides `sib` from its pre-move position to wherever `mutate()` puts it. */
function flipSibling(sib, mutate) {
    const before = sib.getBoundingClientRect();
    mutate();
    const after = sib.getBoundingClientRect();
    const dy = before.top - after.top;
    if (!dy) return;
    sib.style.transition = 'none';
    sib.style.transform = `translateY(${dy}px)`;
    requestAnimationFrame(() => {
        sib.style.transition = 'transform 0.18s ease-out';
        sib.style.transform = '';
    });
}

function initDragHandle(handle, block) {
    let dragging = false;
    let grabOffset = 0;

    const updateVisual = (pointerY) => {
        const desiredTop = pointerY - grabOffset;
        const dy = desiredTop - naturalTop(block);
        block.style.transform = `translateY(${dy}px) scale(1.02)`;
    };

    /** Swaps at most one sibling per call — pointermove fires often enough
     *  that a fast drag still catches up within a couple of events. */
    const checkSwap = () => {
        const container = block.parentElement;
        if (!container) return false;

        const draggedRect = block.getBoundingClientRect();
        const draggedCenter = draggedRect.top + draggedRect.height / 2;

        for (const sib of container.children) {
            if (sib === block) continue;
            const sibRect = sib.getBoundingClientRect();
            const sibCenter = sibRect.top + sibRect.height / 2;
            const draggedIsBefore = Boolean(block.compareDocumentPosition(sib) & Node.DOCUMENT_POSITION_FOLLOWING);

            if (draggedIsBefore && draggedCenter > sibCenter) {
                flipSibling(sib, () => container.insertBefore(block, sib.nextSibling));
                return true;
            }
            if (!draggedIsBefore && draggedCenter < sibCenter) {
                flipSibling(sib, () => container.insertBefore(block, sib));
                return true;
            }
        }
        return false;
    };

    const onMove = (event) => {
        if (!dragging) return;
        event.preventDefault();
        updateVisual(event.clientY);
        if (checkSwap()) updateVisual(event.clientY); // re-anchor after a DOM move
    };

    const finish = async () => {
        if (!dragging) return;
        dragging = false;
        block.classList.remove('dragging');
        block.style.transform = '';
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', finish);
        handle.removeEventListener('pointercancel', finish);

        const container = block.parentElement;
        if (container && session) {
            const order = [...container.children].map((el) => el.dataset.entryKey);
            session.entries.sort((a, b) => order.indexOf(a.exerciseId) - order.indexOf(b.exerciseId));
            await persist();
        }
        render();
    };

    handle.addEventListener('pointerdown', (event) => {
        if (event.button !== undefined && event.button !== 0) return;
        event.preventDefault();
        dragging = true;
        grabOffset = event.clientY - block.getBoundingClientRect().top;
        block.classList.add('dragging');
        try {
            // Keeps the drag alive even if the finger slides off the small
            // handle mid-gesture. Not load-bearing for the drag itself —
            // some environments (and any pointer id the browser doesn't
            // recognize as currently active) reject this, so a failure here
            // shouldn't take the rest of the gesture down with it.
            handle.setPointerCapture(event.pointerId);
        } catch {
            // ignored — see above
        }
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', finish);
        handle.addEventListener('pointercancel', finish);
    });
}

// --- Exercise blocks -----------------------------------------------------

function exerciseBlock(entry, entryIndex) {
    const meta = [entry.equipment, entry.attachment].filter(Boolean).join(' · ');
    const ghost = ghostText(entry.exerciseId);

    // If this workout came from a template, offer to push a rest tweak back to
    // it — but only as a link that appears once the value actually differs,
    // rather than a prompt every time you nudge the stepper.
    const template = session.templateId ? state.templates.find((t) => t.id === session.templateId) : null;
    const templateEntry = template?.exercises.find((e) => e.exerciseId === entry.exerciseId);

    const saveBack = el('button', {
        class: 'link-btn',
        type: 'button',
        text: 'Save to template',
        hidden: true,
        onclick: async () => {
            templateEntry.restSeconds = entry.restSeconds;
            await database.saveTemplate(template);
            saveBack.hidden = true;
            toast('Template rest updated');
        },
    });

    const syncSaveBack = () => {
        if (templateEntry) saveBack.hidden = templateEntry.restSeconds === entry.restSeconds;
    };

    // Scoped to the template, not the session — bound straight to the
    // template's own copy so it stays in sync with the builder, and only
    // shows up for exercises still actually in this template (not one added
    // ad hoc mid-workout, or a workout with no template at all).
    const templateNoteField = templateEntry
        ? noteField({
              label: 'Template note',
              placeholder: 'e.g. this week: pause reps',
              value: templateEntry.note || '',
              onSave: async (value) => {
                  templateEntry.note = value;
                  await database.saveTemplate(template);
              },
          })
        : null;

    const restControl = stepper({
        value: entry.restSeconds,
        min: 5, // 0 silently meant "don't start a timer" — never a real choice
        max: 600,
        step: 15,
        suffix: 's',
        label: 'rest',
        onChange: async (value) => {
            entry.restSeconds = value;
            syncSaveBack();
            await persist();
        },
    });
    syncSaveBack();

    const progressBadge = el('div', {
        class: 'progress-badge',
        hidden: true,
        text: '🎯 Ready to progress — every set hit target reps at your RIR. Add a little weight next time.',
    });
    const refreshProgress = () => { progressBadge.hidden = !isReadyToProgress(entry); };

    // Rebuilt in place rather than via a full render(), so removing a set
    // doesn't reset scroll position or drop you out of edit mode.
    const setList = el('div', { class: 'set-list' });
    const refreshSets = () => {
        clear(setList);
        let workingCount = 0;
        let warmupCount = 0;
        entry.sets.forEach((set, index) => {
            const label = set.warmup ? `W${++warmupCount}` : String(++workingCount);
            setList.append(setRow(entry, set, index, label, refreshSets, refreshProgress));
        });
        refreshProgress();
    };
    refreshSets();

    const editToggle = el('button', {
        class: 'link-btn edit-toggle',
        type: 'button',
        text: 'Edit',
        onclick: () => {
            const editing = block.classList.toggle('editing');
            editToggle.textContent = editing ? 'Done' : 'Edit';
        },
    });

    const dragHandle = el('div', {
        class: 'exercise-drag-handle',
        'aria-label': `Reorder ${entry.exerciseName}`,
        role: 'button',
    }, ['☰']);

    const block = el('div', { class: 'exercise-block', dataset: { entryKey: entry.exerciseId } }, [
        el('div', { class: 'exercise-block-head' }, [
            dragHandle,
            el('div', { class: 'exercise-block-title' }, [
                el('div', { class: 'exercise-block-name' }, [
                    entry.muscleGroup ? el('span', { class: 'muscle-dot', dataset: { muscle: entry.muscleGroup } }) : null,
                    entry.exerciseName,
                ]),
                meta ? el('div', { class: 'exercise-block-meta', text: meta }) : null,
            ]),
            el('div', { class: 'row-controls' }, [
                editToggle,
                el('button', {
                    class: 'icon-btn',
                    type: 'button',
                    'aria-label': 'Swap exercise',
                    onclick: () => swapExercise(entryIndex),
                }, ['⇄']),
                el('button', {
                    class: 'icon-btn danger',
                    type: 'button',
                    'aria-label': 'Remove exercise',
                    onclick: () => removeExercise(entryIndex),
                }, ['×']),
            ]),
        ]),

        progressBadge,
        carriedNote(entry),
        ghost ? el('div', { class: 'ghost-hint', text: ghost }) : null,

        el('div', { class: 'stepper-head' }, [
            el('span', { text: '#' }),
            el('span', { text: 'Reps' }),
            el('span', { text: `Weight (${getUnit()})` }),
            el('span', { text: 'RIR' }),
            el('span', { text: '' }),
        ]),

        setList,

        el('div', { class: 'rest-setting' }, [
            el('div', {}, [
                el('span', { class: 'stepper-label', text: 'Rest between sets' }),
                saveBack,
            ]),
            restControl,
        ]),

        el('div', { class: 'block-actions' }, [
            el('button', {
                class: 'btn btn-outline btn-small',
                type: 'button',
                text: '+ Warm-up',
                onclick: () => addWarmupSet(entry, refreshSets),
            }),
            el('button', {
                class: 'btn btn-outline btn-small',
                type: 'button',
                text: '+ Add set',
                onclick: () => addSet(entry, refreshSets),
            }),
            // Only for barbell work — plate maths is meaningless on a cable
            // stack or a pin-loaded machine, and the button would be noise on
            // most of the list.
            entry.equipment === 'Barbell'
                ? el('button', {
                      class: 'btn btn-outline btn-small',
                      type: 'button',
                      text: 'Plates',
                      onclick: () => openPlateCalculator(heaviestWorkingWeight(entry)),
                  })
                : null,
        ]),

        templateNoteField,
        noteSection(entry),
    ]);

    initDragHandle(dragHandle, block);
    return block;
}

function addSet(entry, refreshSets) {
    const last = entry.sets.at(-1);
    entry.sets.push({
        reps: last?.reps ?? entry.targetReps ?? DEFAULTS.reps,
        weightKg: last?.weightKg ?? 0,
        rir: last?.rir ?? DEFAULTS.rir,
        done: false,
        completedAt: null,
    });
    persist();
    refreshSets();
    updateBanner();
    syncElapsedTimer();
}

/**
 * Warm-up sets always sit ahead of the working sets in the array — inserted
 * right after any existing warm-ups, never mixed in among working sets — so
 * "last working set" lookups elsewhere (addSet, ghost text) keep working
 * unchanged via `.at(-1)`.
 */
function addWarmupSet(entry, refreshSets) {
    const warmupCount = entry.sets.filter((s) => s.warmup).length;
    const firstWorking = entry.sets.find((s) => !s.warmup);
    entry.sets.splice(warmupCount, 0, {
        reps: firstWorking?.reps ?? entry.targetReps ?? DEFAULTS.reps,
        weightKg: firstWorking?.weightKg ?? 0,
        done: false,
        completedAt: null,
        warmup: true,
    });
    persist();
    refreshSets();
    updateBanner();
    syncElapsedTimer();
}

async function removeExercise(index) {
    const entry = session.entries[index];
    const logged = entry.sets.some((s) => s.done);
    const hasNote = Boolean(entry.note?.trim());

    if (logged || hasNote) {
        const message =
            logged && hasNote
                ? `“${entry.exerciseName}” has logged sets and a note. Removing it drops both.`
                : logged
                  ? `“${entry.exerciseName}” has logged sets. Removing it drops them.`
                  : `“${entry.exerciseName}” has a note on it. Removing it drops the note.`;
        const ok = await confirmSheet({ title: 'Remove exercise', message, confirmLabel: 'Remove', danger: true });
        if (!ok) return;
    }
    session.entries.splice(index, 1);
    await persist();
    render();
}

function swapExercise(index) {
    openPicker({
        title: 'Swap For',
        exclude: session.entries.map((entry) => entry.exerciseId),
        onSelect: (exerciseId) => {
            const exercise = findExercise(exerciseId);
            const entry = session.entries[index];
            // Keep the set structure and weights, change what they belong to.
            // The note does NOT carry over — "shoulder hurts on this one" was
            // written about the exercise being replaced, not whatever takes
            // its place.
            Object.assign(entry, {
                exerciseId,
                exerciseName: exercise.name,
                muscleGroup: exercise.muscleGroup || '',
                attachment: exercise.attachment || '',
                equipment: exercise.equipment || '',
                note: '',
            });
            persist();
            render();
            return false;
        },
    });
}

/**
 * Inserting mid-picker plays the entrance animation while the full-screen
 * picker sheet still covers it — invisible, wasted. Instead each newly
 * appended block starts paused at its first frame, and only starts playing
 * once the picker actually closes and the block is something you can see.
 */
function addExercise() {
    const addedBlocks = [];

    const primeEntrance = (block) => {
        block.classList.add('exercise-block-new');
        addedBlocks.push(block);
    };

    openPicker({
        title: 'Add Exercise',
        exclude: session.entries.map((entry) => entry.exerciseId),
        onSelect: (exerciseId) => {
            const entry = entryFromExercise(exerciseId);
            session.entries.push(entry);
            persist();
            toast(`${entry.exerciseName} added`);

            if (!exercisesStack) {
                // Empty workout — the empty-state placeholder needs swapping
                // out for a real list, easiest done with a full rebuild.
                render();
                primeEntrance(exercisesStack.lastElementChild);
            } else {
                const block = exerciseBlock(entry, session.entries.length - 1);
                exercisesStack.append(block);
                primeEntrance(block);
                updateBanner();
                syncElapsedTimer();
            }
            return true; // keep the picker open for adding a few at once
        },
        onClose: () => {
            addedBlocks.forEach((block, index) => {
                // A short stagger reads as each one landing in turn rather
                // than everything popping at once; capped so a big batch
                // doesn't crawl.
                setTimeout(() => {
                    block.style.animationPlayState = 'running';
                    block.addEventListener('animationend', () => {
                        block.classList.remove('exercise-block-new');
                        block.style.animation = '';
                    }, { once: true });
                }, Math.min(index, 4) * 80);
            });
        },
    });
}

// --- Views ---------------------------------------------------------------

function idleView() {
    const body = el('div', {});

    body.append(
        el('button', {
            class: 'btn btn-primary btn-block',
            type: 'button',
            text: 'Start Empty Workout',
            onclick: () => startWorkout(null),
        }),
    );

    if (state.templates.length) {
        body.append(el('div', { class: 'history-group-label', text: 'Start from a template' }));
        const list = el('div', { class: 'stack' });
        state.templates.forEach((template) => {
            const totalSets = template.exercises.reduce((sum, e) => sum + e.sets, 0);
            list.append(
                el('button', { class: 'card', type: 'button', onclick: () => startWorkout(template.id) }, [
                    el('div', { class: 'card-title', text: template.name }),
                    el('div', {
                        class: 'card-meta',
                        text: `${template.exercises.length} exercises · ${totalSets} sets`,
                    }),
                ]),
            );
        });
        body.append(list);
    } else {
        body.append(
            el('div', { class: 'empty-state' }, [
                el('p', { class: 'hint', text: 'Build a template and starting a workout pre-fills every set for you.' }),
            ]),
        );
    }

    if (!canVibrate()) {
        body.append(
            el('p', { class: 'hint footnote', text: 'Rest alerts use sound — iPhone Safari can’t vibrate from a web app. Keep the volume up, or watch the timer bar.' }),
        );
    }

    return body;
}

function summaryText() {
    const doneSets = session.entries.reduce((sum, e) => sum + e.sets.filter((s) => !s.warmup && s.done).length, 0);
    const totalSets = session.entries.reduce((sum, e) => sum + e.sets.filter((s) => !s.warmup).length, 0);
    const volume = session.entries.reduce(
        (sum, e) => sum + e.sets.filter((s) => !s.warmup && s.done).reduce((v, s) => v + s.weightKg * s.reps, 0),
        0,
    );
    const elapsed = formatDuration(Date.now() - new Date(session.startedAt));
    return `${doneSets}/${totalSets} sets · ${elapsed} · ${formatWeight(volume)} volume`;
}

/** Ticking a set updates in place rather than re-rendering, so the running
 *  totals have to be refreshed explicitly or the banner goes stale. */
function updateBanner() {
    if (session && bannerSub) bannerSub.textContent = summaryText();
}

function activeView() {
    const body = el('div', {});
    bannerSub = el('div', { class: 'workout-sub', text: summaryText() });

    body.append(
        el('div', { class: 'workout-banner' }, [
            el('div', {}, [
                el('div', { class: 'workout-title', text: session.name }),
                bannerSub,
            ]),
        ]),
    );

    elapsedEl = el('span', { class: 'workout-timer-value' });
    body.append(
        el('div', { class: 'workout-timer' }, [
            el('span', { class: 'workout-timer-label', text: 'Elapsed' }),
            elapsedEl,
            el('span', { class: 'workout-timer-paused-tag', text: 'Paused — confirm to finish' }),
        ]),
    );
    syncElapsedTimer();

    if (session.entries.length) {
        exercisesStack = el('div', { class: 'stack' }, session.entries.map(exerciseBlock));
        body.append(exercisesStack);
    } else {
        body.append(el('div', { class: 'empty-state', text: 'No exercises yet — add one below.' }));
    }

    body.append(
        el('button', {
            class: 'btn btn-outline btn-block spaced',
            type: 'button',
            text: '+ Add Exercise',
            onclick: addExercise,
        }),
        el('div', { class: 'finish-actions' }, [
            el('button', { class: 'btn btn-outline', type: 'button', text: 'Discard', onclick: () => discardWorkout() }),
            el('button', { class: 'btn btn-success', type: 'button', text: 'Finish Workout', onclick: finishWorkout }),
        ]),
    );

    return body;
}

export function render() {
    bannerSub = null;
    exercisesStack = null;
    stopElapsedTicker();
    elapsedEl = null;
    const container = clear($('#today-body'));
    $('#today-title').textContent = session ? 'Workout' : 'Today';
    container.append(session ? activeView() : idleView());
    document.body.classList.toggle('resting-room', Boolean(session));
}

export function hasActiveSession() {
    return Boolean(session);
}

export function initWorkout({ onWorkoutFinished } = {}) {
    onFinished = onWorkoutFinished;

    // Re-request the lock after the phone is unlocked or the tab is refocused —
    // the browser drops it whenever the page loses visibility.
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && session) {
            acquireWakeLock();
            // A throttled/suspended interval can be stale by several seconds
            // after the tab was backgrounded — repaint immediately.
            if (!timerPaused) tickElapsed();
        }
    });
}
