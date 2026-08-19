import { database } from './db.js';
import { $, el, clear, openModal } from './dom.js';
import { stepper } from './stepper.js';
import { getUnit, toDisplay, fromDisplay, stepWeight, weightPrecision, formatNumber } from './units.js';

/**
 * What to hang on each side of the bar to hit a target weight.
 *
 * All of this works in *display* units rather than the app's usual kg — you
 * load 20 kg plates on a 20 kg bar, or 45 lb plates on a 45 lb bar, and
 * converting between them would invent plate sizes that don't exist in the
 * rack.
 */

const PLATE_SIZES = {
    kg: [25, 20, 15, 10, 5, 2.5, 1.25],
    lb: [45, 35, 25, 10, 5, 2.5],
};

const DEFAULT_BAR = { kg: 20, lb: 45 };

// Plate maths lands on values like 12.499999999999998; every comparison here
// is fuzzed rather than exact so a clean 12.5 doesn't get reported as short.
const EPSILON = 1e-6;

let barWeights = { ...DEFAULT_BAR };

export async function loadBarWeights() {
    const saved = await database.getSetting('barWeights', null);
    barWeights = { ...DEFAULT_BAR, ...(saved || {}) };
}

/**
 * Greedy largest-first, which is optimal for the standard doubling-ish plate
 * sets above. Returns the plates for ONE side, plus what that actually
 * loads to — the target isn't always reachable (a 61 kg target on a 20 kg
 * bar leaves 0.5 kg per side that no plate covers).
 */
export function platesPerSide(target, bar, unit = getUnit()) {
    const perSide = (target - bar) / 2;
    if (perSide < -EPSILON) return { belowBar: true, plates: [], loaded: bar, exact: false };

    const plates = [];
    let remaining = perSide;

    for (const size of PLATE_SIZES[unit]) {
        const count = Math.floor((remaining + EPSILON) / size);
        if (count > 0) {
            plates.push({ size, count });
            remaining -= count * size;
        }
    }

    return {
        belowBar: false,
        plates,
        loaded: target - remaining * 2,
        exact: remaining < EPSILON,
    };
}

function renderResult(container, target, bar, unit) {
    clear(container);
    const result = platesPerSide(target, bar, unit);

    if (result.belowBar) {
        container.append(el('p', { class: 'hint', text: `That's lighter than the bar on its own (${formatNumber(bar)} ${unit}).` }));
        return;
    }

    if (!result.plates.length) {
        container.append(el('p', { class: 'plate-empty', text: 'Just the bar — no plates.' }));
        return;
    }

    // One chip per physical plate, biggest first: it reads as the order you'd
    // actually slide them on, rather than something to mentally unpack.
    const chips = [];
    result.plates.forEach(({ size, count }) => {
        for (let i = 0; i < count; i += 1) {
            chips.push(el('span', { class: 'plate-chip', text: formatNumber(size) }));
        }
    });

    container.append(
        el('div', { class: 'plate-side-label', text: 'Per side' }),
        el('div', { class: 'plate-chips' }, chips),
    );

    if (result.exact) {
        container.append(
            el('div', {
                class: 'plate-total',
                text: `${formatNumber(bar)} bar + ${formatNumber((result.loaded - bar) / 2)} per side = ${formatNumber(result.loaded)} ${unit}`,
            }),
        );
    } else {
        container.append(
            el('div', {
                class: 'plate-total plate-short',
                text: `Closest is ${formatNumber(result.loaded)} ${unit} — ${formatNumber(target - result.loaded)} ${unit} short of ${formatNumber(target)}.`,
            }),
        );
    }
}

export function openPlateCalculator(startWeightKg = 0) {
    const unit = getUnit();
    const body = clear($('#plate-body'));

    let target = toDisplay(startWeightKg, unit);
    let bar = barWeights[unit] ?? DEFAULT_BAR[unit];

    const result = el('div', { class: 'plate-result' });
    const refresh = () => renderResult(result, target, bar, unit);

    const targetStepper = stepper({
        value: target,
        min: 0,
        max: 2000,
        label: 'target weight',
        decimals: true,
        precision: weightPrecision(unit),
        onStep: (base, direction) => stepWeight(base, direction, false, unit),
        onChange: (value) => { target = value; refresh(); },
    });

    const barStepper = stepper({
        value: bar,
        min: 0,
        max: 60,
        label: 'bar weight',
        decimals: true,
        precision: weightPrecision(unit),
        onStep: (base, direction) => stepWeight(base, direction, true, unit),
        onChange: (value) => {
            bar = value;
            refresh();
            // Whatever bar you're on is almost certainly the one you'll be on
            // next time, so it sticks without a save step.
            barWeights = { ...barWeights, [unit]: value };
            database.setSetting('barWeights', barWeights);
        },
    });

    const field = (labelText, control) =>
        el('div', { class: 'stepper-field' }, [
            el('span', { class: 'stepper-label', text: labelText }),
            control,
        ]);

    body.append(
        el('div', { class: 'stepper-grid' }, [
            field(`Target (${unit})`, targetStepper),
            field(`Bar (${unit})`, barStepper),
        ]),
        result,
        el('p', {
            class: 'hint footnote',
            text: `Assumes a standard rack: ${PLATE_SIZES[unit].map(formatNumber).join(', ')} ${unit}.`,
        }),
    );

    refresh();
    openModal('plate-modal');
}
