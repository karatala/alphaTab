import { AlphaTabError, AlphaTabErrorType } from '@coderline/alphatab/AlphaTabError';
import { JsonHelper } from '@coderline/alphatab/io/JsonHelper';
import type { ControllerType } from '@coderline/alphatab/midi/ControllerType';
import {
    AlphaTabMetronomeEvent,
    AlphaTabRestEvent,
    ControlChangeEvent,
    EndOfTrackEvent,
    type MidiEvent,
    MidiEventType,
    NoteBendEvent,
    type NoteEvent,
    NoteOffEvent,
    NoteOnEvent,
    PitchBendEvent,
    ProgramChangeEvent,
    TempoChangeEvent,
    TimeSignatureEvent
} from '@coderline/alphatab/midi/MidiEvent';
import { MidiFile, MidiTrack } from '@coderline/alphatab/midi/MidiFile';

/** @internal */
export interface MidiFileMessage {
    division: number;
    tickShift: number;
    tracks: Float64Array[];
}

/**
 * MIDI-only object conversion for worker messages.
 * @internal
 */
export class MidiFileJsonConverter {
    private static readonly _messageFields: Map<MidiEventType, string[]> = new Map([
        [MidiEventType.TimeSignature, ['numerator', 'denominatorIndex', 'midiClocksPerMetronomeClick', 'thirtySecondNodesInQuarter']],
        [MidiEventType.AlphaTabRest, ['channel']],
        [MidiEventType.AlphaTabMetronome, ['metronomeNumerator', 'metronomeDurationInTicks', 'metronomeDurationInMilliseconds']],
        [MidiEventType.NoteOn, ['channel', 'noteKey', 'noteVelocity']],
        [MidiEventType.NoteOff, ['channel', 'noteKey', 'noteVelocity']],
        [MidiEventType.ControlChange, ['channel', 'controller', 'value']],
        [MidiEventType.ProgramChange, ['channel', 'program']],
        [MidiEventType.TempoChange, ['beatsPerMinute']],
        [MidiEventType.PitchBend, ['channel', 'value']],
        [MidiEventType.PerNotePitchBend, ['channel', 'noteKey', 'value']],
        [MidiEventType.EndOfTrack, []]
    ]);

    /** Packs worker data into caller-independent transferable arrays. @internal */
    public static midiFileToMessage(midi: MidiFile): MidiFileMessage {
        const tracks = midi.tracks.map(track => {
            const values = new Float64Array(track.events.length * 8);
            for (let idx = 0; idx < track.events.length; idx++) {
                const event = track.events[idx];
                const fields = this._messageFields.get(event.type);
                if (!fields) throw new AlphaTabError(AlphaTabErrorType.Format, `Unknown Midi Event type: ${event.type}`);
                const offset = idx * 8;
                values[offset] = event.type; values[offset + 1] = event.track; values[offset + 2] = event.tick;
                for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex++) values[offset + 3 + fieldIndex] = (event as unknown as Record<string, number>)[fields[fieldIndex]];
            }
            return values;
        });
        return { division: midi.division, tickShift: midi.tickShift, tracks };
    }

    /** Restores the existing event classes and ordering on the receiving worker. @internal */
    public static messageToMidiFile(message: MidiFileMessage): MidiFile {
        const midi = new MidiFile();
        midi.division = message.division; midi.tickShift = message.tickShift;
        for (const values of message.tracks) {
            const track = new MidiTrack();
            for (let offset = 0; offset < values.length; offset += 8) {
                const type = values[offset] as MidiEventType;
                const fields = this._messageFields.get(type);
                if (!fields) throw new AlphaTabError(AlphaTabErrorType.Format, `Unknown Midi Event type: ${type}`);
                const event: Record<string, number> = { type, track: values[offset + 1], tick: values[offset + 2] };
                for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex++) {
                    const field = fields[fieldIndex];
                    event[field === 'thirtySecondNodesInQuarter' ? 'thirdySecondNodesInQuarter' : field] = values[offset + 3 + fieldIndex];
                }
                track.events.push(this.jsObjectToMidiEvent(event));
            }
            midi.tracks.push(track);
        }
        return midi;
    }

    /**
     * Converts the given JavaScript object into a MidiFile object.
     * @param jsObject The javascript object to deserialize.
     * @returns The converted MidiFile.
     */
    public static jsObjectToMidiFile(jsObject: unknown): MidiFile {
        const midi2: MidiFile = new MidiFile();

        JsonHelper.forEach(jsObject, (entryValue, entryKey) => {
            switch (entryKey) {
                case 'tickShift':
                    midi2.tickShift = entryValue as number;
                    break;
                case 'division':
                    midi2.division = entryValue as number;
                    break;
                case 'tracks':
                    for (const midiTrack of entryValue as unknown[]) {
                        const midiTrack2: MidiTrack = MidiFileJsonConverter._jsObjectToMidiTrack(midiTrack);
                        midi2.tracks.push(midiTrack2);
                    }
                    break;
            }
        });

        return midi2;
    }

    private static _jsObjectToMidiTrack(jsObject: unknown): MidiTrack {
        const midi2: MidiTrack = new MidiTrack();

        JsonHelper.forEach(jsObject, (entryValue, entryKey) => {
            switch (entryKey) {
                case 'events':
                    for (const midiEvent of entryValue as unknown[]) {
                        const midiEvent2: MidiEvent = MidiFileJsonConverter.jsObjectToMidiEvent(midiEvent);
                        midi2.events.push(midiEvent2);
                    }
                    break;
            }
        });

        return midi2;
    }

    /**
     * Converts the given JavaScript object into a MidiEvent object.
     * @param jsObject The javascript object to deserialize.
     * @returns The converted MidiEvent.
     */
    public static jsObjectToMidiEvent(midiEvent: unknown): MidiEvent {
        const track: number = JsonHelper.getValue(midiEvent, 'track') as number;
        const tick: number = JsonHelper.getValue(midiEvent, 'tick') as number;
        const type: MidiEventType = JsonHelper.getValue(midiEvent, 'type') as number as MidiEventType;

        switch (type) {
            case MidiEventType.TimeSignature:
                return new TimeSignatureEvent(
                    track,
                    tick,
                    JsonHelper.getValue(midiEvent, 'numerator') as number,
                    JsonHelper.getValue(midiEvent, 'denominatorIndex') as number,
                    JsonHelper.getValue(midiEvent, 'midiClocksPerMetronomeClick') as number,
                    JsonHelper.getValue(midiEvent, 'thirdySecondNodesInQuarter') as number
                );
            case MidiEventType.AlphaTabRest:
                return new AlphaTabRestEvent(track, tick, JsonHelper.getValue(midiEvent, 'channel') as number);
            case MidiEventType.AlphaTabMetronome:
                return new AlphaTabMetronomeEvent(
                    track,
                    tick,
                    JsonHelper.getValue(midiEvent, 'metronomeNumerator') as number,
                    JsonHelper.getValue(midiEvent, 'metronomeDurationInTicks') as number,
                    JsonHelper.getValue(midiEvent, 'metronomeDurationInMilliseconds') as number
                );
            case MidiEventType.NoteOn:
                return new NoteOnEvent(
                    track,
                    tick,
                    JsonHelper.getValue(midiEvent, 'channel') as number,
                    JsonHelper.getValue(midiEvent, 'noteKey') as number,
                    JsonHelper.getValue(midiEvent, 'noteVelocity') as number
                );
            case MidiEventType.NoteOff:
                return new NoteOffEvent(
                    track,
                    tick,
                    JsonHelper.getValue(midiEvent, 'channel') as number,
                    JsonHelper.getValue(midiEvent, 'noteKey') as number,
                    JsonHelper.getValue(midiEvent, 'noteVelocity') as number
                );
            case MidiEventType.ControlChange:
                return new ControlChangeEvent(
                    track,
                    tick,
                    JsonHelper.getValue(midiEvent, 'channel') as number,
                    JsonHelper.getValue(midiEvent, 'controller') as number as ControllerType,
                    JsonHelper.getValue(midiEvent, 'value') as number
                );
            case MidiEventType.ProgramChange:
                return new ProgramChangeEvent(
                    track,
                    tick,
                    JsonHelper.getValue(midiEvent, 'channel') as number,
                    JsonHelper.getValue(midiEvent, 'program') as number
                );
            case MidiEventType.TempoChange:
                const tempo = new TempoChangeEvent(tick, 0);
                tempo.beatsPerMinute = JsonHelper.getValue(midiEvent, 'beatsPerMinute') as number;
                return tempo;
            case MidiEventType.PitchBend:
                return new PitchBendEvent(
                    track,
                    tick,
                    JsonHelper.getValue(midiEvent, 'channel') as number,
                    JsonHelper.getValue(midiEvent, 'value') as number
                );
            case MidiEventType.PerNotePitchBend:
                return new NoteBendEvent(
                    track,
                    tick,
                    JsonHelper.getValue(midiEvent, 'channel') as number,
                    JsonHelper.getValue(midiEvent, 'noteKey') as number,
                    JsonHelper.getValue(midiEvent, 'value') as number
                );
            case MidiEventType.EndOfTrack:
                return new EndOfTrackEvent(track, tick);
        }

        throw new AlphaTabError(AlphaTabErrorType.Format, `Unknown Midi Event type: ${type}`);
    }

    /**
     * Converts the given MidiFile object into a serialized JavaScript object.
     * @param midi The midi file to convert.
     * @returns A serialized MidiFile object without ciruclar dependencies that can be used for further serializations.
     */
    public static midiFileToJsObject(midi: MidiFile): Map<string, unknown> {
        const serialized = new Map<string, unknown>();
        serialized.set('division', midi.division);
        serialized.set('tickShift', midi.tickShift);

        const tracks: Map<string, unknown>[] = [];
        for (const track of midi.tracks) {
            tracks.push(MidiFileJsonConverter._midiTrackToJsObject(track));
        }
        serialized.set('tracks', tracks);

        return serialized;
    }

    private static _midiTrackToJsObject(midi: MidiTrack): Map<string, unknown> {
        const serialized = new Map<string, unknown>();

        const events: Map<string, unknown>[] = [];
        for (const track of midi.events) {
            events.push(MidiFileJsonConverter.midiEventToJsObject(track));
        }
        serialized.set('events', events);

        return serialized;
    }

    /**
     * Converts the given MidiEvent object into a serialized JavaScript object.
     * @param midi The midi file to convert.
     * @returns A serialized MidiEvent object without ciruclar dependencies that can be used for further serializations.
     */
    public static midiEventToJsObject(midiEvent: MidiEvent): Map<string, unknown> {
        const serialized = new Map<string, unknown>();
        serialized.set('track', midiEvent.track);
        serialized.set('tick', midiEvent.tick);
        serialized.set('type', midiEvent.type as number);
        switch (midiEvent.type) {
            case MidiEventType.TimeSignature:
                serialized.set('numerator', (midiEvent as TimeSignatureEvent).numerator);
                serialized.set('denominatorIndex', (midiEvent as TimeSignatureEvent).denominatorIndex);
                serialized.set('midiClocksPerMetronomeClick', (midiEvent as TimeSignatureEvent).midiClocksPerMetronomeClick);
                serialized.set('thirdySecondNodesInQuarter', (midiEvent as TimeSignatureEvent).thirtySecondNodesInQuarter);
                break;
            case MidiEventType.AlphaTabRest:
                serialized.set('channel', (midiEvent as AlphaTabRestEvent).channel);
                break;
            case MidiEventType.AlphaTabMetronome:
                serialized.set('metronomeNumerator', (midiEvent as AlphaTabMetronomeEvent).metronomeNumerator);
                serialized.set(
                    'metronomeDurationInMilliseconds',
                    (midiEvent as AlphaTabMetronomeEvent).metronomeDurationInMilliseconds
                );
                serialized.set('metronomeDurationInTicks', (midiEvent as AlphaTabMetronomeEvent).metronomeDurationInTicks);
                break;
            case MidiEventType.NoteOn:
            case MidiEventType.NoteOff:
                serialized.set('channel', (midiEvent as NoteEvent).channel);
                serialized.set('noteKey', (midiEvent as NoteEvent).noteKey);
                serialized.set('noteVelocity', (midiEvent as NoteEvent).noteVelocity);
                break;
            case MidiEventType.ControlChange:
                serialized.set('channel', (midiEvent as ControlChangeEvent).channel);
                serialized.set('controller', (midiEvent as ControlChangeEvent).controller as number);
                serialized.set('value', (midiEvent as ControlChangeEvent).value);
                break;
            case MidiEventType.ProgramChange:
                serialized.set('channel', (midiEvent as ProgramChangeEvent).channel);
                serialized.set('program', (midiEvent as ProgramChangeEvent).program);
                break;
            case MidiEventType.TempoChange:
                serialized.set('beatsPerMinute', (midiEvent as TempoChangeEvent).beatsPerMinute);
                break;
            case MidiEventType.PitchBend:
                serialized.set('channel', (midiEvent as PitchBendEvent).channel);
                serialized.set('value', (midiEvent as PitchBendEvent).value);
                break;
            case MidiEventType.PerNotePitchBend:
                serialized.set('channel', (midiEvent as NoteBendEvent).channel);
                serialized.set('noteKey', (midiEvent as NoteBendEvent).noteKey);
                serialized.set('value', (midiEvent as NoteBendEvent).value);
                break;
            case MidiEventType.EndOfTrack:
                break;
        }

        return serialized;
    }
}
