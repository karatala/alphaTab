import type { NoteGainPoint } from '@coderline/alphatab/midi/MidiEvent';

type EffectEdge = { mode: 'default' | 'cut' | 'skip-short'; threshold: number };

export interface MidiBeatEffectWindow {
    start: number;
    end: number;
    left?: EffectEdge;
    right?: EffectEdge;
}

type EffectSampleWriter = (tick: number, value: number) => void;

/** @internal */
export function noteGainAt(points: readonly NoteGainPoint[], tick: number): number {
    const idx = points.findIndex(point => point.tick > tick);
    if (idx < 0) return points[points.length - 1].gain;
    if (idx === 0) return points[0].gain;
    const previous = points[idx - 1];
    const next = points[idx];
    return previous.gain + (next.gain - previous.gain) * (tick - previous.tick) / (next.tick - previous.tick);
}

/** @internal */
export function sliceBeatEffectTiming(window: MidiBeatEffectWindow | undefined, barStart: number, attack: number, duration: number) {
    const release = attack + duration;
    if (!window) {
        return { start: attack, end: release };
    }
    const left = barStart + window.start;
    const right = barStart + window.end;
    const cutLeft = attack < left;
    const crossesRight = release > right;
    const inside = Math.min(release, right) - Math.max(attack, left);
    if (
        attack >= right ||
        (cutLeft && (!window.left || window.left.mode === 'default' || inside <= 0)) ||
        (cutLeft && window.left?.mode === 'skip-short' && inside <= window.left.threshold && inside <= left - attack) ||
        (crossesRight && window.right?.mode === 'skip-short' && inside <= window.right.threshold && inside <= release - right)
    ) {
        return null;
    }
    return { start: Math.max(attack, left), end: crossesRight && window.right?.mode === 'cut' ? right : release };
}

/**
 * Keeps the original samples and the last held value at a left cut.
 * Returns true when the original end and its cleanup remain part of the effect.
 * @internal
 */
export function writeBeatEffectSlice(window: MidiBeatEffectWindow | undefined, barStart: number, attack: number, duration: number, resetValue: number, write: EffectSampleWriter, generate: (write: EffectSampleWriter) => void): boolean {
    if (!window) {
        generate(write);
        return true;
    }
    const range = sliceBeatEffectTiming(window, barStart, attack, duration);
    if (!range) {
        return false;
    }
    const { start: left, end: right } = range;
    const cutLeft = left > attack;
    const cutRight = right < attack + duration;
    if (!cutLeft && !cutRight) {
        generate(write);
        return true;
    }

    let seed = cutLeft;
    let held: number | undefined;
    generate((tick, value) => {
        if (cutLeft && tick < left) {
            held = value;
            return;
        }
        if (seed && tick > left && held !== undefined) {
            write(left, held);
        }
        seed = false;
        if (!cutRight || tick < right) {
            write(tick, value);
        }
    });
    if (seed && held !== undefined) {
        write(left, held);
    }
    if (cutRight) {
        write(right, resetValue);
    }
    return !cutRight;
}
