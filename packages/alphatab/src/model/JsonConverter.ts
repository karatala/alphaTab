import { ScoreSerializer } from '@coderline/alphatab/generated/model/ScoreSerializer';
import { SettingsSerializer } from '@coderline/alphatab/generated/SettingsSerializer';
import type { MidiEvent } from '@coderline/alphatab/midi/MidiEvent';
import type { MidiFile } from '@coderline/alphatab/midi/MidiFile';
import { MidiFileJsonConverter } from '@coderline/alphatab/midi/MidiFileJsonConverter';
import { Score } from '@coderline/alphatab/model/Score';
import { Settings } from '@coderline/alphatab/Settings';

/**
 * This class can convert a full {@link Score} instance to a simple JavaScript object and back for further
 * JSON serialization.
 * @public
 */
export class JsonConverter {
    /**
     * @target web
     */
    private static _jsonReplacer(_: any, v: any) {
        if (v instanceof Map) {
            if ('fromEntries' in Object) {
                return Object.fromEntries(v);
            }
            const o: any = {};
            for (const [k, mv] of v) {
                o[k] = mv;
            }
            return o;
        }
        if (ArrayBuffer.isView(v)) {
            return Array.apply([], [v]);
        }
        return v;
    }

    /**
     * Converts the given score into a JSON encoded string.
     * @param score The score to serialize.
     * @returns A JSON encoded string.
     * @target web
     */
    public static scoreToJson(score: Score): string {
        const obj: unknown = JsonConverter.scoreToJsObject(score);
        return JSON.stringify(obj, JsonConverter._jsonReplacer);
    }

    /**
     * Converts the given JSON string back to a {@link Score} object.
     * @param json The JSON string
     * @param settings The settings to use during conversion.
     * @returns The converted score object.
     * @target web
     */
    public static jsonToScore(json: string, settings?: Settings): Score {
        return JsonConverter.jsObjectToScore(JSON.parse(json), settings);
    }

    /**
     * Converts the score into a JavaScript object without circular dependencies.
     * @param score The score object to serialize
     * @returns A serialized score object without ciruclar dependencies that can be used for further serializations.
     */
    public static scoreToJsObject(score: Score): Map<string, unknown>|null {
        return ScoreSerializer.toJson(score);
    }

    /**
     * Converts the given JavaScript object into a score object.
     * @param jsObject The javascript object created via {@link Score}
     * @param settings The settings to use during conversion.
     * @returns The converted score object.
     */
    public static jsObjectToScore(jsObject: unknown, settings?: Settings): Score {
        const score: Score = new Score();
        ScoreSerializer.fromJson(score, jsObject);
        score.finish(settings ?? new Settings());
        return score;
    }

    /**
     * Converts the given settings into a JSON encoded string.
     * @param settings The settings to serialize.
     * @returns A JSON encoded string.
     * @target web
     */
    public static settingsToJson(settings: Settings): string {
        const obj: unknown = JsonConverter.settingsToJsObject(settings);
        return JSON.stringify(obj, JsonConverter._jsonReplacer);
    }

    /**
     * Converts the given JSON string back to a {@link Score} object.
     * @param json The JSON string
     * @returns The converted settings object.
     * @target web
     */
    public static jsonToSettings(json: string): Settings {
        return JsonConverter.jsObjectToSettings(JSON.parse(json));
    }

    /**
     * Converts the settings object into a JavaScript object for transmission between components or saving purposes.
     * @param settings The settings object to serialize
     * @returns A serialized settings object without ciruclar dependencies that can be used for further serializations.
     */
    public static settingsToJsObject(settings: Settings): Map<string, unknown> | null {
        return SettingsSerializer.toJson(settings);
    }

    /**
     * Converts the given JavaScript object into a settings object.
     * @param jsObject The javascript object created via {@link Settings}
     * @returns The converted Settings object.
     */
    public static jsObjectToSettings(jsObject: unknown): Settings {
        const settings: Settings = new Settings();
        SettingsSerializer.fromJson(settings, jsObject);
        return settings;
    }

    /**
     * Converts the given JavaScript object into a MidiFile object.
     * @param jsObject The javascript object to deserialize.
     * @returns The converted MidiFile.
     */
    public static jsObjectToMidiFile(jsObject: unknown): MidiFile {
        return MidiFileJsonConverter.jsObjectToMidiFile(jsObject);
    }

    /**
     * Converts the given JavaScript object into a MidiEvent object.
     * @param jsObject The javascript object to deserialize.
     * @returns The converted MidiEvent.
     */
    public static jsObjectToMidiEvent(midiEvent: unknown): MidiEvent {
        return MidiFileJsonConverter.jsObjectToMidiEvent(midiEvent);
    }

    /**
     * Converts the given MidiFile object into a serialized JavaScript object.
     * @param midi The midi file to convert.
     * @returns A serialized MidiFile object without ciruclar dependencies that can be used for further serializations.
     */
    public static midiFileToJsObject(midi: MidiFile): Map<string, unknown> {
        return MidiFileJsonConverter.midiFileToJsObject(midi);
    }

    /**
     * Converts the given MidiEvent object into a serialized JavaScript object.
     * @param midi The midi file to convert.
     * @returns A serialized MidiEvent object without ciruclar dependencies that can be used for further serializations.
     */
    public static midiEventToJsObject(midiEvent: MidiEvent): Map<string, unknown> {
        return MidiFileJsonConverter.midiEventToJsObject(midiEvent);
    }
}
