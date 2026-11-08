import type { NoteOffEvent, NoteOnEvent } from '@coderline/alphatab/midi/MidiEvent';
import { type Bar, SustainPedalMarkerType } from '@coderline/alphatab/model/Bar';
import type { Staff } from '@coderline/alphatab/model/Staff';

type PedalSpan = { start: number; end: number };
type StaffPedal = { spans: PedalSpan[]; press: number | null; previousBar: number };
type NoteRelease = { attack: NoteOnEvent; release: NoteOffEvent; pedal: StaffPedal | undefined };

/** Applies notation pedal to the note pairs written by the playback MIDI handler. */
export class SustainPedalPlayback {
    private readonly _staves = new Map<Staff, StaffPedal>();
    private readonly _keys = new Map<number, NoteRelease[]>();
    private _current: StaffPedal | undefined;

    public constructor(staves: readonly Staff[], private readonly _channels: ReadonlySet<number>) {
        for (const staff of staves) {
            this._staves.set(staff, { spans: [], press: null, previousBar: -1 });
        }
    }

    public beginBar(bar: Bar, tick: number) {
        const state = this._staves.get(bar.staff);
        this._current = state;
        if (!state) {
            return;
        }
        if (bar.index !== state.previousBar + 1) {
            this._release(state, tick);
        }
        state.previousBar = bar.index;
        if (!bar.sustainPedals.length) {
            return;
        }
        const duration = bar.masterBar.calculateDuration();
        const markers = bar.sustainPedals.slice().sort((first, second) => first.ratioPosition - second.ratioPosition);
        for (const marker of markers) {
            if (!(marker.ratioPosition >= 0 && marker.ratioPosition <= 1)) {
                continue;
            }
            const position = tick + Math.round(duration * marker.ratioPosition);
            if (marker.pedalType === SustainPedalMarkerType.Up) {
                this._release(state, position);
            } else if (marker.pedalType === SustainPedalMarkerType.Down && state.press === null) {
                state.press = position;
            }
        }
    }

    private _release(state: StaffPedal, tick: number) {
        if (state.press !== null && state.press < tick) {
            state.spans.push({ start: state.press, end: tick });
        }
        state.press = null;
    }

    public addNote(attack: NoteOnEvent, release: NoteOffEvent) {
        if (!this._channels.has(attack.channel) || attack.noteVelocity === 0) {
            return;
        }
        const key = attack.channel * 128 + attack.noteKey;
        const notes = this._keys.get(key);
        const pair = { attack, release, pedal: this._current };
        if (notes) {
            notes.push(pair);
        } else {
            this._keys.set(key, [pair]);
        }
    }

    public finish(tick: number, tickShift: number): boolean {
        for (const state of this._staves.values()) {
            this._release(state, tick);
        }
        let changed = false;
        for (const notes of this._keys.values()) {
            if (!notes.some(note => note.pedal?.spans.length)) {
                continue;
            }
            notes.sort((first, second) => first.attack.tick - second.attack.tick);
            let nextRelease = Number.POSITIVE_INFINITY;
            for (let idx = notes.length - 1; idx >= 0; idx--) {
                const { attack, release, pedal } = notes[idx];
                if (pedal) {
                    const end = this._pedalEnd(pedal.spans, attack.tick - tickShift) + tickShift;
                    // Equal keys on a channel release in attack order. Do not introduce a new inversion.
                    const held = Math.min(end, nextRelease);
                    if (held > release.tick) {
                        release.tick = held;
                        changed = true;
                    }
                }
                nextRelease = Math.min(nextRelease, release.tick);
            }
        }
        return changed;
    }

    private _pedalEnd(spans: readonly PedalSpan[], tick: number): number {
        let low = 0;
        let high = spans.length;
        while (low < high) {
            const mid = (low + high) >>> 1;
            if (spans[mid].start <= tick) {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        return low > 0 && tick < spans[low - 1].end ? spans[low - 1].end : tick;
    }
}
