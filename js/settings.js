import { database } from './db.js';
import { loadExercises, loadTemplates, loadWorkouts } from './store.js';
import { $, el, clear, openModal, confirmSheet, toast } from './dom.js';
import { getUnit, setUnit } from './units.js';

let onDataChanged = null;
let onUnitChanged = null;

function unitRow() {
    const kgBtn = el('button', { type: 'button', text: 'kg' });
    const lbBtn = el('button', { type: 'button', text: 'lb' });

    const sync = () => {
        const unit = getUnit();
        kgBtn.classList.toggle('active', unit === 'kg');
        lbBtn.classList.toggle('active', unit === 'lb');
    };
    sync();

    const choose = async (unit) => {
        if (unit === getUnit()) return;
        setUnit(unit);
        await database.setSetting('unit', unit);
        sync();
        onUnitChanged?.();
    };

    kgBtn.addEventListener('click', () => choose('kg'));
    lbBtn.addEventListener('click', () => choose('lb'));

    return el('div', { class: 'setting-row' }, [
        el('div', {}, [
            el('div', { class: 'setting-title', text: 'Weight unit' }),
            el('div', { class: 'setting-desc', text: 'Applies everywhere — logged weights convert, nothing is rewritten.' }),
        ]),
        el('div', { class: 'segmented' }, [kgBtn, lbBtn]),
    ]);
}

async function exportBackup() {
    const data = await database.exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const date = new Date().toISOString().slice(0, 10);

    const link = el('a', { href: url, download: `gym-tracker-backup-${date}.json` });
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    toast('Backup downloaded');
}

async function importBackup(file) {
    let data;
    try {
        data = JSON.parse(await file.text());
    } catch {
        toast('That file isn’t valid JSON');
        return;
    }

    if (data?.format !== 'gym-tracker-backup') {
        toast('Not a Gym Tracker backup file');
        return;
    }

    const ok = await confirmSheet({
        title: 'Import backup',
        message: `This adds ${data.exercises?.length ?? 0} exercises, ${data.templates?.length ?? 0} templates and ${data.workouts?.length ?? 0} workouts from ${new Date(data.exportedAt).toLocaleDateString()}. Anything sharing an ID with existing data gets overwritten; nothing else is removed. Demo photos/clips aren’t included in backups and won’t come back.`,
        confirmLabel: 'Import',
        danger: true,
    });
    if (!ok) return;

    try {
        await database.importAll(data);
    } catch (error) {
        toast(`Import failed: ${error.message}`);
        return;
    }

    setUnit(await database.getSetting('unit', getUnit()));
    await Promise.all([loadExercises(), loadTemplates(), loadWorkouts()]);
    onDataChanged?.();
    onUnitChanged?.();
    toast('Backup imported');
}

function backupRow() {
    const fileInput = el('input', { type: 'file', accept: 'application/json', hidden: true });
    fileInput.addEventListener('change', () => {
        const file = fileInput.files?.[0];
        if (file) importBackup(file);
        fileInput.value = '';
    });

    return el('div', { class: 'setting-row' }, [
        el('div', {}, [
            el('div', { class: 'setting-title', text: 'Backup' }),
            el('div', { class: 'setting-desc', text: 'Export saves everything except demo photos/clips. This is your only way off this phone.' }),
        ]),
        el('div', { class: 'media-buttons' }, [
            el('button', { class: 'btn btn-outline btn-small', type: 'button', text: 'Export', onclick: exportBackup }),
            el('label', { class: 'btn btn-outline btn-small file-btn' }, ['Import', fileInput]),
        ]),
    ]);
}

function renderSettings() {
    clear($('#settings-body')).append(unitRow(), backupRow());
}

export function initSettings({ onDataChanged: dataCb, onUnitChanged: unitCb } = {}) {
    onDataChanged = dataCb;
    onUnitChanged = unitCb;

    $('#settings-btn').addEventListener('click', () => {
        renderSettings();
        openModal('settings-modal');
    });
}
