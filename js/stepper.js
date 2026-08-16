import { el, bindHold } from './dom.js';

/**
 * Big −/+ control with an editable value in the middle. The input stays a real
 * text field with inputmode="decimal" so typing is possible when you want it,
 * but the thumb-sized buttons mean you never have to mid-set.
 */
export function stepper({
    value,
    min = 0,
    max = Infinity,
    step = 1,
    label = '',
    suffix = '',
    decimals = false,
    precision = 2,
    onChange,
    onStep,
}) {
    const input = el('input', {
        class: 'stepper-input',
        type: 'text',
        inputmode: decimals ? 'decimal' : 'numeric',
        value: String(value),
    });

    const clamp = (n) => Math.min(max, Math.max(min, n));
    const factor = 10 ** precision;

    const commit = (next, fromButton) => {
        const rounded = Math.round(clamp(next) * factor) / factor;
        input.value = String(rounded);
        onChange?.(rounded, fromButton);
    };

    const nudge = (direction) => {
        const current = parseFloat(input.value);
        const base = Number.isFinite(current) ? current : min;
        commit(onStep ? onStep(base, direction) : base + direction * step, true);
    };

    const minus = el('button', { class: 'stepper-btn', type: 'button', 'aria-label': `Decrease ${label}` }, ['−']);
    const plus = el('button', { class: 'stepper-btn', type: 'button', 'aria-label': `Increase ${label}` }, ['+']);
    bindHold(minus, () => nudge(-1));
    bindHold(plus, () => nudge(1));

    input.addEventListener('focus', () => input.select());

    // Strips anything that isn't a digit (and, for weight, a single decimal
    // point) as you type — pasting or typing "12kg" or "1.2.3" can't produce
    // a value that later parses as garbage, rather than only catching it
    // once you've already tapped away.
    input.addEventListener('input', () => {
        let next = decimals ? input.value.replace(/[^\d.]/g, '') : input.value.replace(/\D/g, '');
        if (decimals) {
            const firstDot = next.indexOf('.');
            if (firstDot !== -1) next = next.slice(0, firstDot + 1) + next.slice(firstDot + 1).replace(/\./g, '');
        }
        if (next !== input.value) input.value = next;
    });

    // A blank or otherwise unparseable field — including one left blank by
    // the filter above — snaps to `min` rather than staying invalid, so
    // there's never a state where a set could be logged with no reps, or a
    // rest timer with no duration, just because the field was cleared.
    input.addEventListener('change', () => {
        const parsed = parseFloat(input.value);
        commit(Number.isFinite(parsed) ? parsed : min, false);
    });

    const valueBox = el('div', { class: `stepper-value${suffix ? ' has-suffix' : ''}` }, [
        input,
        suffix ? el('span', { class: 'stepper-suffix', text: suffix }) : null,
    ]);

    const wrap = el('div', { class: 'stepper' }, [minus, valueBox, plus]);

    wrap.setValue = (next) => {
        input.value = String(Math.round(clamp(next) * factor) / factor);
    };
    wrap.getValue = () => {
        const parsed = parseFloat(input.value);
        return Number.isFinite(parsed) ? parsed : min;
    };
    return wrap;
}

export function labelledStepper(labelText, options) {
    const control = stepper({ ...options, label: labelText });
    const field = el('div', { class: 'stepper-field' }, [
        el('span', { class: 'stepper-label', text: labelText }),
        control,
    ]);
    field.control = control;
    return field;
}
