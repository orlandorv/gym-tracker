export function $(selector, root = document) {
    return root.querySelector(selector);
}

export function $$(selector, root = document) {
    return Array.from(root.querySelectorAll(selector));
}

/**
 * Builds an element. Text content is set via textContent, never innerHTML, so
 * user-entered exercise names containing quotes or angle brackets are inert.
 */
export function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.entries(props).forEach(([key, value]) => {
        if (value === null || value === undefined || value === false) return;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else if (key.startsWith('on') && typeof value === 'function') {
            node.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (key === 'value') node.value = value;
        else if (value === true) node.setAttribute(key, '');
        else node.setAttribute(key, value);
    });
    (Array.isArray(children) ? children : [children])
        .filter(Boolean)
        .forEach((child) => node.append(child));
    return node;
}

export function clear(node) {
    node.replaceChildren();
    return node;
}

// --- Modal stack ---------------------------------------------------------
// A stack rather than a single reference, because the exercise picker opens on
// top of the template editor and closing it must not dismiss both.

const stack = [];
const closeHandlers = new Map();

export function openModal(id) {
    const modal = document.getElementById(id);
    if (!modal || stack.includes(id)) return;
    modal.style.zIndex = String(200 + stack.length * 10);
    modal.classList.add('active');
    stack.push(id);
    document.body.classList.add('modal-open');
}

export function closeModal(id) {
    const target = id || stack[stack.length - 1];
    if (!target) return;
    const index = stack.indexOf(target);
    if (index === -1) return;
    document.getElementById(target)?.classList.remove('active');
    stack.splice(index, 1);
    if (stack.length === 0) document.body.classList.remove('modal-open');
    closeHandlers.get(target)?.forEach((handler) => handler());
}

/**
 * Fires once the given modal actually closes, however that happens (Done
 * button, backdrop tap, Escape). Useful for work that only makes sense once
 * the sheet is out of the way and its content is visible again — e.g.
 * playing an entrance animation for something added while a picker covered
 * the screen. Returns an unsubscribe function.
 */
export function onModalClosed(id, handler) {
    if (!closeHandlers.has(id)) closeHandlers.set(id, new Set());
    closeHandlers.get(id).add(handler);
    return () => closeHandlers.get(id)?.delete(handler);
}

export function closeAllModals() {
    while (stack.length) closeModal();
}

export function isModalOpen(id) {
    return stack.includes(id);
}

// --- Feedback ------------------------------------------------------------

let toastTimer = null;

export function toast(message) {
    let node = document.getElementById('toast');
    if (!node) {
        node = el('div', { id: 'toast', class: 'toast' });
        document.body.append(node);
    }
    node.textContent = message;
    node.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove('visible'), 2600);
}

/**
 * Promise-based confirm sheet — window.confirm is ugly and blocking on iOS.
 *
 * Must resolve no matter how the sheet goes away — Confirm, Cancel, a
 * backdrop tap, or Escape — and must resolve exactly once. Without both of
 * those: dismissing via backdrop/Escape left the promise hanging forever
 * *and* left that dismissed call's button listeners attached to the shared
 * #confirm-accept/#confirm-cancel elements, so the next time any confirm
 * sheet was genuinely confirmed, every abandoned one fired alongside it —
 * confirming a harmless dialog could silently also execute a "Delete" or
 * "Discard" from a dialog you thought you'd backed out of.
 */
export function confirmSheet({ title, message, confirmLabel = 'Confirm', danger = false }) {
    return new Promise((resolve) => {
        const okBtn = $('#confirm-accept');
        const cancelBtn = $('#confirm-cancel');
        $('#confirm-title').textContent = title;
        $('#confirm-body').textContent = message;
        okBtn.textContent = confirmLabel;
        okBtn.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;

        let settled = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            okBtn.removeEventListener('click', onOk);
            cancelBtn.removeEventListener('click', onCancel);
            unsubscribeClose();
            resolve(result);
        };

        // Covers backdrop tap and Escape — anything that isn't a direct
        // Confirm/Cancel click still has to settle this promise and detach
        // these listeners.
        const unsubscribeClose = onModalClosed('confirm-modal', () => finish(false));

        const onOk = () => { finish(true); closeModal('confirm-modal'); };
        const onCancel = () => { finish(false); closeModal('confirm-modal'); };

        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
        openModal('confirm-modal');
    });
}

// --- Note fields -----------------------------------------------------------

/**
 * Add-link + autosaving textarea: collapsed to a "+ {label}" link when empty,
 * an editable field (debounced on input, flushed on blur) once it has
 * content. Shared by the exercise-level and template-level note fields so
 * they read as the same interaction wherever they appear.
 */
export function noteField({ label, placeholder = '', value = '', onSave }) {
    let saveTimer = null;

    const caption = el('span', { class: 'stepper-label note-field-label', text: label, hidden: !value });

    const field = el('textarea', {
        class: 'form-input note-input',
        rows: 2,
        placeholder,
        value,
        hidden: !value,
    });

    const addLink = el('button', {
        class: 'link-btn',
        type: 'button',
        text: `+ ${label}`,
        hidden: Boolean(value),
    });

    addLink.addEventListener('click', () => {
        caption.hidden = false;
        field.hidden = false;
        addLink.hidden = true;
        field.focus();
    });

    field.addEventListener('input', () => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => onSave(field.value), 500);
    });

    field.addEventListener('blur', () => {
        clearTimeout(saveTimer);
        onSave(field.value);
        if (!field.value.trim()) {
            caption.hidden = true;
            field.hidden = true;
            addLink.hidden = false;
        }
    });

    return el('div', { class: 'note-section' }, [addLink, caption, field]);
}

// --- Steppers ------------------------------------------------------------

/**
 * Wires press-and-hold repeat onto a +/- button. Uses pointer events so it
 * works for both touch and mouse, and cancels on pointercancel (which fires
 * when iOS decides a touch became a scroll).
 */
export function bindHold(button, action) {
    let timeout = null;
    let interval = null;

    const stop = () => {
        clearTimeout(timeout);
        clearInterval(interval);
        timeout = null;
        interval = null;
    };

    button.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        action();
        timeout = setTimeout(() => {
            interval = setInterval(action, 90);
        }, 450);
    });

    ['pointerup', 'pointerleave', 'pointercancel'].forEach((type) => {
        button.addEventListener(type, stop);
    });
}
