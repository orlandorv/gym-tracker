import { bootstrap } from './store.js';
import { $$, el, closeModal } from './dom.js';
import { initLibrary, renderLibrary, releaseMediaUrls } from './library.js';
import { initTemplates, renderTemplates } from './templates.js';
import { initPicker } from './picker.js';
import { initTimer } from './timer.js';
import { initSfx } from './sfx.js';
import { initWorkout, render as renderWorkout, startWorkout, resumeActive } from './workout.js';
import { renderRecords } from './records.js';
import { initHistory, renderHistory } from './history.js';
import { initSettings } from './settings.js';

function switchTab(tab) {
    $$('.tab-content').forEach((section) => section.classList.toggle('active', section.id === `${tab}-tab`));
    $$('.nav-btn').forEach((button) => button.classList.toggle('active', button.dataset.tab === tab));
    window.scrollTo(0, 0);
}

function initChrome() {
    $$('.nav-btn').forEach((button) => {
        button.addEventListener('click', () => switchTab(button.dataset.tab));
    });

    // Close buttons resolve their own modal, so nested sheets close one layer
    // at a time instead of collapsing the whole stack.
    $$('.modal-close, .modal-cancel').forEach((button) => {
        button.addEventListener('click', () => closeModal(button.closest('.modal').id));
    });

    $$('.modal').forEach((modal) => {
        modal.addEventListener('click', (event) => {
            if (event.target === modal) closeModal(modal.id);
        });
        modal.addEventListener('transitionend', () => {
            if (!modal.classList.contains('active')) releaseMediaUrls();
        });
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') closeModal();
    });
}

/**
 * Registered relative ('./sw.js'), not '/sw.js' — GitHub Pages serves this
 * from /<repo>/, not the domain root, so an absolute path would 404 there
 * even though it works fine in local dev at the root. Fire-and-forget: a
 * registration failure shouldn't block the app from working, it just means
 * no offline support this session.
 */
function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('./sw.js').catch((error) => {
        console.warn('Service worker registration failed:', error);
    });
}

/** Every weight-displaying view, refreshed after a unit toggle or a backup import. */
function renderAll() {
    renderLibrary();
    renderTemplates();
    renderWorkout();
    renderHistory();
    renderRecords();
}

async function start() {
    registerServiceWorker();
    await bootstrap();

    initChrome();
    initLibrary();
    initPicker();
    initTimer();
    initSfx();
    initWorkout({
        onWorkoutFinished: () => {
            renderHistory();
            renderRecords();
        },
    });
    initTemplates({
        onStart: (templateId) => startWorkout(templateId),
        onTemplatesChanged: renderWorkout,
    });
    initHistory({ onHistoryChanged: renderRecords });
    initSettings({ onDataChanged: renderAll, onUnitChanged: renderAll });

    await resumeActive();

    renderAll();
}

start().catch((error) => {
    console.error(error);
    document.body.prepend(
        el('div', { class: 'fatal-error', text: `Could not start: ${error.message}` }),
    );
});
