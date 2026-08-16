const KG_PER_LB = 0.45359237;

// Weight is stored canonically in kg at full float precision and converted only
// at the display/input boundary, so toggling units never drifts stored data.
export const STEPS = {
    kg: { coarse: 2.5, fine: 1.25 },
    lb: { coarse: 5, fine: 2.5 },
};

// kg conversions land on clean 2-decimal numbers (2.5/1.25 steps); lb
// conversions don't (100 kg -> 220.4622...), so lb is shown to 1dp.
const DISPLAY_DECIMALS = { kg: 2, lb: 1 };

export function weightPrecision(unit = currentUnit) {
    return DISPLAY_DECIMALS[unit] ?? 2;
}

function roundTo(value, decimals) {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
}

let currentUnit = 'kg';

export function setUnit(unit) {
    currentUnit = unit === 'lb' ? 'lb' : 'kg';
    return currentUnit;
}

export function getUnit() {
    return currentUnit;
}

export function toDisplay(kg, unit = currentUnit) {
    const value = unit === 'lb' ? kg / KG_PER_LB : kg;
    return roundTo(value, weightPrecision(unit));
}

export function fromDisplay(value, unit = currentUnit) {
    return unit === 'lb' ? value * KG_PER_LB : value;
}

/** Trims trailing zeros: 45 -> "45", 42.5 -> "42.5". */
export function formatNumber(value) {
    if (!Number.isFinite(value)) return '0';
    return String(Math.round(value * 100) / 100);
}

export function formatWeight(kg, unit = currentUnit) {
    return `${formatNumber(toDisplay(kg, unit))} ${unit}`;
}

/** Nudge a displayed weight by one step, clamped at zero. */
export function stepWeight(displayValue, direction, fine = false, unit = currentUnit) {
    const step = fine ? STEPS[unit].fine : STEPS[unit].coarse;
    const next = displayValue + direction * step;
    return Math.max(0, roundTo(next, weightPrecision(unit)));
}

/** H:MM:SS (or M:SS-scale hours never drop, matching a stopwatch readout). */
export function formatStopwatch(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function formatDuration(ms) {
    const totalMinutes = Math.max(0, Math.round(ms / 60000));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function formatClock(seconds) {
    const safe = Math.max(0, Math.ceil(seconds));
    const minutes = Math.floor(safe / 60);
    return `${minutes}:${String(safe % 60).padStart(2, '0')}`;
}

export function formatRest(seconds) {
    if (seconds >= 60) {
        const minutes = Math.floor(seconds / 60);
        const rest = seconds % 60;
        return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
    }
    return `${seconds}s`;
}
