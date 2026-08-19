import { database, DEFAULTS } from './db.js';
import { state, loadTemplates, loadExercises, findExercise } from './store.js';
import { $, $$, el, clear, openModal, closeModal, confirmSheet, toast, noteField } from './dom.js';
import { labelledStepper } from './stepper.js';
import { openPicker } from './picker.js';
import { formatRest } from './units.js';

// Working copy of the template being edited. Nothing touches IndexedDB until
// Save, so backing out of the sheet discards cleanly.
let draft = null;

// Today's idle view lists templates to start from, but it only rebuilds when
// something tells it to — without this, a deleted (or newly created)
// template lingers there until an unrelated render happens to touch it.
let onChange = null;

function renderRows() {
    const container = clear($('#template-rows'));

    if (!draft.exercises.length) {
        container.append(el('div', { class: 'empty-state small', text: 'No exercises yet — add your first below.' }));
        return;
    }

    draft.exercises.forEach((entry, index) => {
        const exercise = findExercise(entry.exerciseId);
        const name = exercise?.name || 'Removed exercise';

        const setsField = labelledStepper('Sets', {
            value: entry.sets,
            min: 1,
            max: 20,
            onChange: (value) => { entry.sets = value; },
        });
        const rirField = labelledStepper('RIR', {
            value: entry.rir ?? DEFAULTS.rir,
            min: 0,
            max: 10,
            onChange: (value) => { entry.rir = value; },
        });
        // The ceiling of the rep range, not a literal per-set target — double
        // progression only adds weight once every working set reaches this
        // number at the intended RIR. Actual reps are still logged live.
        const targetRepsField = labelledStepper('Target reps', {
            value: entry.reps ?? DEFAULTS.reps,
            min: 1,
            max: 100,
            onChange: (value) => { entry.reps = value; },
        });
        const restField = labelledStepper('Rest', {
            value: entry.restSeconds,
            min: 5, // 0 silently meant "don't start a timer" — never a real choice
            max: 600,
            step: 15,
            suffix: 's',
            onChange: (value) => { entry.restSeconds = value; },
        });

        // Always with the exercise, regardless of which template it's in —
        // edits here write straight to the exercise record, same as editing
        // it from the Library.
        const exerciseNoteField = exercise
            ? noteField({
                  label: 'Exercise note',
                  placeholder: 'e.g. elbow feels better with a slight incline',
                  value: exercise.note || '',
                  onSave: async (value) => {
                      await database.saveExercise({ ...exercise, note: value });
                      await loadExercises();
                  },
              })
            : null;

        // Scoped to this template only — part of the draft, so it's only
        // persisted when the template itself is saved.
        const templateNoteField = noteField({
            label: 'Template note',
            placeholder: 'e.g. this week: pause reps',
            value: entry.note || '',
            onSave: (value) => { entry.note = value; },
        });

        container.append(
            el('div', { class: 'template-row' }, [
                el('div', { class: 'template-row-head' }, [
                    el('div', {}, [
                        el('div', { class: 'template-row-name' }, [
                            exercise ? el('span', { class: 'muscle-dot', dataset: { muscle: exercise.muscleGroup } }) : null,
                            name,
                        ]),
                        el('div', {
                            class: 'template-row-meta',
                            text: exercise
                                ? [exercise.muscleGroup, exercise.attachment || exercise.equipment].filter(Boolean).join(' · ')
                                : 'This exercise was deleted',
                        }),
                    ]),
                    el('div', { class: 'row-controls' }, [
                        el('button', {
                            class: 'icon-btn',
                            type: 'button',
                            'aria-label': 'Move up',
                            disabled: index === 0,
                            onclick: () => move(index, -1),
                        }, ['↑']),
                        el('button', {
                            class: 'icon-btn',
                            type: 'button',
                            'aria-label': 'Move down',
                            disabled: index === draft.exercises.length - 1,
                            onclick: () => move(index, 1),
                        }, ['↓']),
                        el('button', {
                            class: 'icon-btn danger',
                            type: 'button',
                            'aria-label': 'Remove',
                            onclick: () => {
                                draft.exercises.splice(index, 1);
                                renderRows();
                            },
                        }, ['×']),
                    ]),
                ]),
                el('div', { class: 'stepper-grid' }, [setsField, rirField, targetRepsField, restField]),
                exerciseNoteField,
                templateNoteField,
            ]),
        );
    });
}

function move(index, direction) {
    const target = index + direction;
    if (target < 0 || target >= draft.exercises.length) return;
    const [entry] = draft.exercises.splice(index, 1);
    draft.exercises.splice(target, 0, entry);
    renderRows();
}

/**
 * Yes/No for whether this template's sets count toward the weekly volume
 * targets on History. Undefined means yes, so templates predating the flag
 * keep counting without a migration.
 */
function syncPlanToggle() {
    const inPlan = draft.inWeeklyPlan !== false;
    $$('#template-in-plan button').forEach((button) => {
        button.classList.toggle('active', (button.dataset.value === 'yes') === inPlan);
    });
}

export function openTemplateForm(templateId = null) {
    const existing = templateId ? state.templates.find((t) => t.id === templateId) : null;

    draft = existing
        ? { ...existing, exercises: existing.exercises.map((entry) => ({ ...entry })) }
        : { name: '', exercises: [] };

    $('#template-form-title').textContent = existing ? 'Edit Template' : 'New Template';
    $('#template-name').value = draft.name;
    $('#delete-template-btn').hidden = !existing;
    syncPlanToggle();
    renderRows();
    openModal('template-form-modal');
}

function addExerciseToDraft() {
    openPicker({
        title: 'Add to Template',
        exclude: draft.exercises.map((entry) => entry.exerciseId),
        onSelect: (exerciseId) => {
            draft.exercises.push({ exerciseId, ...DEFAULTS });
            renderRows();
            return true; // keep the picker open for building a full day in one go
        },
    });
}

async function submitTemplate(event) {
    event.preventDefault();
    const name = $('#template-name').value.trim();
    if (!name) return;
    if (!draft.exercises.length) {
        toast('Add at least one exercise');
        return;
    }

    draft.name = name;
    await database.saveTemplate(draft);
    await loadTemplates();
    renderTemplates();
    onChange?.();
    closeModal('template-form-modal');
    toast('Template saved');
}

async function deleteTemplate() {
    const ok = await confirmSheet({
        title: 'Delete template',
        message: `Delete “${draft.name || 'this template'}”? Workouts already logged from it are kept.`,
        confirmLabel: 'Delete',
        danger: true,
    });
    if (!ok) return;

    await database.deleteTemplate(draft.id);
    await loadTemplates();
    renderTemplates();
    onChange?.();
    closeModal('template-form-modal');
    toast('Template deleted');
}

export function renderTemplates() {
    const container = clear($('#templates-list'));

    if (!state.templates.length) {
        container.append(
            el('div', { class: 'empty-state' }, [
                el('p', { text: 'No templates yet.' }),
                el('p', { class: 'hint', text: 'Build one — “Push Day”, “Legs” — and starting a workout pre-fills every set.' }),
            ]),
        );
        return;
    }

    state.templates.forEach((template) => {
        const totalSets = template.exercises.reduce((sum, entry) => sum + entry.sets, 0);
        const rest = template.exercises.length
            ? Math.round(template.exercises.reduce((sum, e) => sum + e.restSeconds, 0) / template.exercises.length)
            : 0;

        container.append(
            el('div', { class: 'card template-card' }, [
                el('div', { class: 'card-title', text: template.name }),
                el('div', {
                    class: 'card-meta',
                    text: `${template.exercises.length} exercises · ${totalSets} sets · ~${formatRest(rest)} rest`,
                }),
                el('div', { class: 'card-preview', text: template.exercises
                    .map((entry) => findExercise(entry.exerciseId)?.name)
                    .filter(Boolean)
                    .join(' • ') }),
                el('div', { class: 'card-actions' }, [
                    el('button', { class: 'btn btn-primary', type: 'button', text: 'Start', dataset: { start: template.id } }),
                    el('button', { class: 'btn btn-outline', type: 'button', text: 'Edit', dataset: { edit: template.id } }),
                ]),
            ]),
        );
    });
}

export function initTemplates({ onStart, onTemplatesChanged }) {
    onChange = onTemplatesChanged;
    $('#create-template-btn').addEventListener('click', () => openTemplateForm());
    $('#template-add-exercise').addEventListener('click', addExerciseToDraft);
    $('#template-form').addEventListener('submit', submitTemplate);
    $('#delete-template-btn').addEventListener('click', deleteTemplate);

    $('#template-in-plan').addEventListener('click', (event) => {
        const button = event.target.closest('button[data-value]');
        if (!button || !draft) return;
        draft.inWeeklyPlan = button.dataset.value === 'yes';
        syncPlanToggle();
    });

    $('#templates-list').addEventListener('click', (event) => {
        const startBtn = event.target.closest('[data-start]');
        if (startBtn) return onStart(startBtn.dataset.start);
        const editBtn = event.target.closest('[data-edit]');
        if (editBtn) openTemplateForm(editBtn.dataset.edit);
    });
}
