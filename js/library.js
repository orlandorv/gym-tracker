import { database } from './db.js';
import { MUSCLE_GROUPS, EQUIPMENT } from './seed.js';
import { state, loadExercises, findExercise } from './store.js';
import { $, el, clear, openModal, closeModal, confirmSheet, toast, noteField } from './dom.js';

let pendingMediaFile = null;
let pendingMediaCleared = false;
let editingId = null;
const objectUrls = new Set();

function trackUrl(blob) {
    const url = URL.createObjectURL(blob);
    objectUrls.add(url);
    return url;
}

/** Blob URLs leak the whole file until revoked — drop them on modal close. */
export function releaseMediaUrls() {
    objectUrls.forEach((url) => URL.revokeObjectURL(url));
    objectUrls.clear();
}

function mediaNode(record, { className = 'media-preview' } = {}) {
    const url = trackUrl(record.blob);
    if ((record.type || '').startsWith('video')) {
        return el('video', { src: url, class: className, autoplay: true, loop: true, muted: true, playsinline: true });
    }
    return el('img', { src: url, class: className, alt: '' });
}

function filtered() {
    const search = $('#search-input').value.trim().toLowerCase();
    const muscle = $('#muscle-filter').value;
    const equipment = $('#equipment-filter').value;

    return state.exercises.filter((exercise) => {
        const haystack = `${exercise.name} ${exercise.notes} ${exercise.attachment || ''}`.toLowerCase();
        return (
            (!search || haystack.includes(search)) &&
            (!muscle || exercise.muscleGroup === muscle) &&
            (!equipment || exercise.equipment === equipment)
        );
    });
}

function exerciseCard(exercise) {
    const badges = [
        el('span', { class: 'badge badge-muscle', text: exercise.muscleGroup, dataset: { muscle: exercise.muscleGroup } }),
        el('span', { class: 'badge badge-equipment', text: exercise.equipment }),
    ];
    if (exercise.attachment) {
        badges.push(el('span', { class: 'badge badge-attachment', text: exercise.attachment }));
    }
    if (exercise.isCustom) {
        badges.push(el('span', { class: 'badge badge-custom', text: 'Custom' }));
    }

    return el('button', { class: 'card exercise-card', type: 'button', dataset: { id: exercise.id } }, [
        el('div', { class: 'card-title', text: exercise.name }),
        el('div', { class: 'badge-row' }, badges),
    ]);
}

export function renderLibrary() {
    const container = clear($('#exercises-list'));
    const list = filtered();

    $('#library-count').textContent = `${list.length} of ${state.exercises.length}`;

    if (!list.length) {
        container.append(el('div', { class: 'empty-state', text: 'No exercises match those filters.' }));
        return;
    }
    list.forEach((exercise) => container.append(exerciseCard(exercise)));
}

async function openDetails(exerciseId) {
    const exercise = findExercise(exerciseId);
    if (!exercise) return;

    $('#detail-exercise-name').textContent = exercise.name;
    const body = clear($('#exercise-details-body'));

    if (exercise.mediaId) {
        const record = await database.getMedia(exercise.mediaId);
        if (record) body.append(el('div', { class: 'media-frame' }, mediaNode(record)));
    }

    const field = (label, value) =>
        el('div', { class: 'detail-field' }, [
            el('div', { class: 'detail-label', text: label }),
            el('div', { class: 'detail-value', text: value }),
        ]);

    body.append(
        el('div', { class: 'detail-field' }, [
            el('div', { class: 'detail-label', text: 'Muscle group' }),
            el('div', { class: 'detail-value muscle-value' }, [
                el('span', { class: 'muscle-dot', dataset: { muscle: exercise.muscleGroup } }),
                exercise.muscleGroup,
            ]),
        ]),
    );
    body.append(field('Equipment', exercise.equipment));
    if (exercise.attachment) body.append(field('Attachment / setup', exercise.attachment));
    body.append(field('Form notes', exercise.notes));

    // Personal note: separate from the (stock, uneditable) Form notes above —
    // a reminder that's always with this exercise regardless of which
    // template it's used in. Editable even on stock exercises, unlike the
    // rest of the record.
    body.append(
        el('div', { class: 'detail-field note-field-inline' }, [
            noteField({
                label: 'Personal note',
                placeholder: 'e.g. elbow feels better with a slight incline',
                value: exercise.note || '',
                onSave: async (value) => {
                    await database.saveExercise({ ...exercise, note: value });
                    await loadExercises();
                },
            }),
        ]),
    );

    const actions = clear($('#exercise-detail-actions'));
    if (exercise.isCustom) {
        actions.append(
            el('button', {
                class: 'btn btn-outline',
                type: 'button',
                text: 'Edit',
                onclick: () => {
                    closeModal('exercise-details-modal');
                    openExerciseForm(exercise.id);
                },
            }),
            el('button', {
                class: 'btn btn-danger',
                type: 'button',
                text: 'Delete',
                onclick: () => deleteExercise(exercise),
            }),
        );
    } else {
        actions.append(el('p', { class: 'hint', text: 'Stock exercises can’t be edited — add a custom one to tweak the setup.' }));
    }

    openModal('exercise-details-modal');
}

async function deleteExercise(exercise) {
    const usedIn = state.templates.filter((template) =>
        template.exercises.some((entry) => entry.exerciseId === exercise.id),
    );

    const message = usedIn.length
        ? `“${exercise.name}” is used in ${usedIn.length} template${usedIn.length > 1 ? 's' : ''} (${usedIn
              .map((t) => t.name)
              .join(', ')}). Deleting removes it from them too. Past workouts keep their record.`
        : `Delete “${exercise.name}”? Past workouts keep their record.`;

    const ok = await confirmSheet({ title: 'Delete exercise', message, confirmLabel: 'Delete', danger: true });
    if (!ok) return;

    for (const template of usedIn) {
        template.exercises = template.exercises.filter((entry) => entry.exerciseId !== exercise.id);
        await database.saveTemplate(template);
    }
    if (exercise.mediaId) await database.deleteMedia(exercise.mediaId);
    await database.deleteExercise(exercise.id);

    await loadExercises();
    closeModal('exercise-details-modal');
    renderLibrary();
    toast('Exercise deleted');
}

function renderMediaPreview(record) {
    const slot = clear($('#exercise-media-preview'));
    if (!record) {
        slot.append(el('div', { class: 'media-placeholder', text: 'No clip or image yet' }));
        $('#exercise-media-clear').hidden = true;
        return;
    }
    slot.append(mediaNode(record, { className: 'media-preview small' }));
    $('#exercise-media-clear').hidden = false;
}

export async function openExerciseForm(exerciseId = null) {
    editingId = exerciseId;
    pendingMediaFile = null;
    pendingMediaCleared = false;

    const form = $('#exercise-form');
    form.reset();
    $('#exercise-media-input').value = '';

    const exercise = exerciseId ? findExercise(exerciseId) : null;
    $('#exercise-form-title').textContent = exercise ? 'Edit Exercise' : 'Add Exercise';

    if (exercise) {
        $('#exercise-name').value = exercise.name;
        $('#exercise-muscle').value = exercise.muscleGroup;
        $('#exercise-equipment').value = exercise.equipment;
        $('#exercise-attachment').value = exercise.attachment || '';
        $('#exercise-notes').value = exercise.notes;
        renderMediaPreview(exercise.mediaId ? await database.getMedia(exercise.mediaId) : null);
    } else {
        renderMediaPreview(null);
    }

    openModal('exercise-form-modal');
}

async function submitExerciseForm(event) {
    event.preventDefault();
    const existing = editingId ? findExercise(editingId) : null;

    let mediaId = existing?.mediaId || null;
    if (pendingMediaCleared && mediaId) {
        await database.deleteMedia(mediaId);
        mediaId = null;
    }
    if (pendingMediaFile) {
        if (mediaId) await database.deleteMedia(mediaId);
        const saved = await database.saveMedia(pendingMediaFile);
        mediaId = saved.id;
    }

    await database.saveExercise({
        id: editingId || undefined,
        createdAt: existing?.createdAt,
        name: $('#exercise-name').value.trim(),
        muscleGroup: $('#exercise-muscle').value,
        equipment: $('#exercise-equipment').value,
        attachment: $('#exercise-attachment').value.trim(),
        notes: $('#exercise-notes').value.trim(),
        mediaId,
        isCustom: true,
    });

    await loadExercises();
    renderLibrary();
    closeModal('exercise-form-modal');
    toast(editingId ? 'Exercise updated' : 'Exercise added');
    editingId = null;
}

function populateSelect(select, values, allLabel) {
    clear(select);
    if (allLabel) select.append(el('option', { value: '', text: allLabel }));
    else select.append(el('option', { value: '', text: 'Select…' }));
    values.forEach((value) => select.append(el('option', { value, text: value })));
}

export function initLibrary() {
    populateSelect($('#muscle-filter'), MUSCLE_GROUPS, 'All muscles');
    populateSelect($('#equipment-filter'), EQUIPMENT, 'All gear');
    populateSelect($('#exercise-muscle'), MUSCLE_GROUPS);
    populateSelect($('#exercise-equipment'), EQUIPMENT);

    $('#search-input').addEventListener('input', renderLibrary);
    $('#muscle-filter').addEventListener('change', renderLibrary);
    $('#equipment-filter').addEventListener('change', renderLibrary);

    // Delegation, so card markup carries only a data-id and never an inline handler.
    $('#exercises-list').addEventListener('click', (event) => {
        const card = event.target.closest('.exercise-card');
        if (card) openDetails(card.dataset.id);
    });

    $('#add-exercise-btn').addEventListener('click', () => openExerciseForm());
    $('#exercise-form').addEventListener('submit', submitExerciseForm);

    $('#exercise-media-input').addEventListener('change', async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        pendingMediaFile = file;
        pendingMediaCleared = false;
        renderMediaPreview({ blob: file, type: file.type });
    });

    $('#exercise-media-clear').addEventListener('click', () => {
        pendingMediaFile = null;
        pendingMediaCleared = true;
        $('#exercise-media-input').value = '';
        renderMediaPreview(null);
    });
}
