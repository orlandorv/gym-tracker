import { state } from './store.js';
import { $, el, clear, openModal, closeModal, onModalClosed } from './dom.js';

// One picker sheet shared by the template builder and mid-workout "add
// exercise", opened with a callback rather than each caller rebuilding a list.

let onPick = null;
let excluded = new Set();
let unsubscribeClose = null;

function render() {
    const search = $('#picker-search').value.trim().toLowerCase();
    const list = clear($('#picker-list'));

    const matches = state.exercises.filter(
        (exercise) =>
            !excluded.has(exercise.id) &&
            (!search || `${exercise.name} ${exercise.muscleGroup} ${exercise.equipment}`.toLowerCase().includes(search)),
    );

    if (!matches.length) {
        list.append(el('div', { class: 'empty-state', text: 'Nothing matches that search.' }));
        return;
    }

    matches.forEach((exercise) => {
        list.append(
            el('button', { class: 'picker-row', type: 'button', dataset: { id: exercise.id } }, [
                el('span', { class: 'muscle-dot', dataset: { muscle: exercise.muscleGroup } }),
                el('div', { class: 'picker-row-body' }, [
                    el('div', { class: 'picker-name', text: exercise.name }),
                    el('div', {
                        class: 'picker-meta',
                        text: [exercise.muscleGroup, exercise.equipment, exercise.attachment].filter(Boolean).join(' · '),
                    }),
                ]),
                el('span', { class: 'picker-add', text: '+' }),
            ]),
        );
    });
}

export function openPicker({ title = 'Add Exercise', exclude = [], onSelect, onClose }) {
    onPick = onSelect;
    excluded = new Set(exclude);
    $('#picker-title').textContent = title;
    $('#picker-search').value = '';
    render();
    openModal('exercise-picker-modal');
    // Deliberately not focusing the search field — that pops the iOS keyboard
    // over the list every time the sheet opens.

    unsubscribeClose?.();
    unsubscribeClose = onClose ? onModalClosed('exercise-picker-modal', onClose) : null;
}

// How long the checkmark flash sits before the row disappears (via the
// exclude-and-rebuild below) — long enough to register as confirmation,
// short enough that rapid-fire picking doesn't feel laggy.
const PICK_FEEDBACK_MS = 280;

export function initPicker() {
    $('#picker-search').addEventListener('input', render);
    $('#picker-list').addEventListener('click', (event) => {
        const row = event.target.closest('.picker-row');
        if (!row || row.classList.contains('picker-row-picked')) return;

        // Confirm the tap registered — checkmark flash — before the list
        // reshuffles underneath it and the row vanishes with no acknowledgment.
        row.classList.add('picker-row-picked');
        const icon = row.querySelector('.picker-add');
        if (icon) icon.textContent = '✓';

        setTimeout(() => {
            const keepOpen = onPick?.(row.dataset.id);
            if (keepOpen) {
                excluded.add(row.dataset.id);
                render();
            } else {
                closeModal('exercise-picker-modal');
            }
        }, PICK_FEEDBACK_MS);
    });
}
