import {
    AlphaTabRestEvent,
    ControlChangeEvent,
    EndOfTrackEvent,
    type NoteGainPoint,
    NoteBendEvent,
    NoteOffEvent,
    NoteOnEvent,
    PitchBendEvent,
    ProgramChangeEvent,
    TempoChangeEvent,
    TimeSignatureEvent
} from '@coderline/alphatab/midi/MidiEvent';
import { SustainPedalPlayback } from '@coderline/alphatab/midi/SustainPedalPlayback';
import { noteGainAt } from '@coderline/alphatab/midi/MidiBeatEffectSlice';
import type { Bar } from '@coderline/alphatab/model/Bar';
import type { Note } from '@coderline/alphatab/model/Note';
import type { Staff } from '@coderline/alphatab/model/Staff';
import type { IMidiFileHandler } from '@coderline/alphatab/midi/IMidiFileHandler';
import { type MidiFile, MidiFileFormat } from '@coderline/alphatab/midi/MidiFile';
import { SynthConstants } from '@coderline/alphatab/synth/SynthConstants';
import type { ControllerType } from '@coderline/alphatab/midi/ControllerType';

/**
 * This implementation of the {@link IMidiFileHandler}
 * generates a {@link MidiFile} object which can be used in AlphaSynth for playback.
 * @public
 */
export class AlphaSynthMidiFileHandler implements IMidiFileHandler {
    private _midiFile: MidiFile;
    private _smf1Mode: boolean;
    private _sustainPedals: SustainPedalPlayback | null = null;
    private _nextNotePairId = 1;
    private _noteGainEnvelope?: readonly NoteGainPoint[];
    private _gainNote?: { note: Note; tick: number; pair?: { attack: NoteOnEvent; release: NoteOffEvent } };
    private readonly _tiedGainAttacks = new Map<number, { attack: NoteOnEvent; release: NoteOffEvent }>();

    /**
     * An indicator by how many midi-ticks the song contents are shifted.
     * Grace beats at start might require a shift for the first beat to start at 0.
     * This information can be used to translate back the player time axis to the music notation.
     */
    public tickShift: number = 0;

    /**
     * Initializes a new instance of the {@link AlphaSynthMidiFileHandler} class.
     * @param midiFile The midi file.
     * @param smf1Mode Whether to generate a SMF1 compatible midi file. This might break multi note bends.
     */
    public constructor(midiFile: MidiFile, smf1Mode: boolean = false) {
        this._midiFile = midiFile;
        this._smf1Mode = smf1Mode;
    }

    public addTickShift(tickShift: number) {
        this._tiedGainAttacks.clear();
        this._midiFile.tickShift = tickShift;
        this.tickShift = tickShift;
    }

    public addTimeSignature(tick: number, timeSignatureNumerator: number, timeSignatureDenominator: number): void {
        tick += this.tickShift;

        let denominatorIndex: number = 0;
        let denominator = timeSignatureDenominator;
        while (true) {
            denominator = denominator >> 1;
            if (denominator > 0) {
                denominatorIndex++;
            } else {
                break;
            }
        }

        this._midiFile.addEvent(new TimeSignatureEvent(0, tick, timeSignatureNumerator, denominatorIndex, 48, 8));
    }

    public addRest(track: number, tick: number, channel: number): void {
        tick += this.tickShift;
        if (!this._smf1Mode) {
            this._midiFile.addEvent(new AlphaTabRestEvent(track, tick, channel));
        }
    }

    public startSustainPedalPlayback(staves: readonly Staff[], channels: ReadonlySet<number>) {
        if (!this._smf1Mode && staves.length > 0) {
            this._sustainPedals = new SustainPedalPlayback(staves, channels);
        }
    }

    public beginSustainPedalBar(bar: Bar, tick: number) {
        this._sustainPedals?.beginBar(bar, tick);
    }

    public finishSustainPedalPlayback(tick: number) {
        if (this._sustainPedals?.finish(tick, this.tickShift)) {
            for (const track of this._midiFile.tracks) {
                track.events.sort((first, second) => first.tick - second.tick);
            }
        }
        this._sustainPedals = null;
    }

    public setNoteGainEnvelope(points?: readonly NoteGainPoint[]) {
        this._noteGainEnvelope = !this._smf1Mode && points ? points.map(point => ({ tick: point.tick + this.tickShift, gain: point.gain })) : undefined;
    }

    public beginNoteGain(note: Note, tick: number) {
        if (!this._smf1Mode) this._gainNote = { note, tick: tick + this.tickShift };
    }

    public endNoteGain() {
        const current = this._gainNote;
        this._gainNote = undefined;
        if (!current) return;
        const { note, tick } = current;
        const origin = note.tieOrigin ?? (note.slideOrigin?.slideTarget === note ? note.slideOrigin : undefined);
        const continued = origin && this._tiedGainAttacks.get(origin.id);
        if (origin) this._tiedGainAttacks.delete(origin.id);
        const pair = current.pair ?? (continued && continued.attack.tick <= tick && continued.release.tick > tick ? continued : undefined);
        if (!pair) return;
        if (!current.pair && this._noteGainEnvelope?.length) {
            const start = this._noteGainEnvelope[0].tick;
            const previous = pair.attack.gainEnvelope;
            pair.attack.gainEnvelope = [
                ...(previous?.filter(point => point.tick < start) ?? []),
                { tick: start, gain: previous ? noteGainAt(previous, start) : 1 },
                ...this._noteGainEnvelope
            ];
        }
        if (note.tieDestination || note.slideTarget) this._tiedGainAttacks.set(note.id, pair);
    }

    public addNote(track: number, start: number, length: number, key: number, velocity: number, channel: number): void {
        start += this.tickShift;
        const noteKey = AlphaSynthMidiFileHandler._fixValue(key);
        const noteVelocity = AlphaSynthMidiFileHandler._fixValue(velocity);
        const attack = new NoteOnEvent(track, start, channel, noteKey, noteVelocity);
        attack.gainEnvelope = this._noteGainEnvelope;
        const release = new NoteOffEvent(track, start + length, channel, noteKey, noteVelocity);
        if (!this._smf1Mode) {
            attack.notePairId = release.notePairId = this._nextNotePairId++;
        }
        if (this._gainNote) this._gainNote.pair = { attack, release };
        this._midiFile.addEvent(attack);
        this._midiFile.addEvent(release);
        this._sustainPedals?.addNote(attack, release);
    }

    private static _fixValue(value: number): number {
        if (value > 127) {
            return 127;
        }
        if (value < 0) {
            return 0;
        }
        return value;
    }

    public addControlChange(
        track: number,
        tick: number,
        channel: number,
        controller: ControllerType,
        value: number,
        noteFade?: true
    ): void {
        tick += this.tickShift;
        const event = new ControlChangeEvent(track, tick, channel, controller, AlphaSynthMidiFileHandler._fixValue(value));
        event.noteFade = noteFade;
        this._midiFile.addEvent(event);
    }

    public addProgramChange(track: number, tick: number, channel: number, program: number): void {
        tick += this.tickShift;
        this._midiFile.addEvent(new ProgramChangeEvent(track, tick, channel, program));
    }

    public addTempo(tick: number, tempo: number): void {
        tick += this.tickShift;
        // bpm -> microsecond per quarter note
        const tempoEvent = new TempoChangeEvent(tick, 0);
        tempoEvent.beatsPerMinute = tempo;
        this._midiFile.addEvent(tempoEvent);
    }

    public addBend(track: number, tick: number, channel: number, value: number): void {
        tick += this.tickShift;
        if (value >= SynthConstants.MaxPitchWheel) {
            value = SynthConstants.MaxPitchWheel;
        } else {
            value = Math.floor(value);
        }
        this._midiFile.addEvent(new PitchBendEvent(track, tick, channel, value));
    }

    public addNoteBend(track: number, tick: number, channel: number, key: number, value: number): void {
        tick += this.tickShift;
        if (this._smf1Mode) {
            this.addBend(track, tick, channel, value);
        } else {
            // map midi 1.0 range of 0-16384     (0x4000)
            // to midi 2.0 range of 0-4294967296 (0x100000000)
            value = (value * SynthConstants.MaxPitchWheel20) / SynthConstants.MaxPitchWheel;

            this._midiFile.addEvent(new NoteBendEvent(track, tick, channel, key, value));
        }
    }

    public finishTrack(track: number, tick: number): void {
        tick += this.tickShift;
        if (this._midiFile.format === MidiFileFormat.MultiTrack || track === 0) {
            this._midiFile.addEvent(new EndOfTrackEvent(track, tick));
        }
    }
}
