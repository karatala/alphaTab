import type { Beat } from '@coderline/alphatab/model/Beat';
import type { MasterBar } from '@coderline/alphatab/model/MasterBar';
import type { Note } from '@coderline/alphatab/model/Note';
import type { Score } from '@coderline/alphatab/model/Score';
import { BarBounds } from '@coderline/alphatab/rendering/utils/BarBounds';
import { BeatBounds } from '@coderline/alphatab/rendering/utils/BeatBounds';
import { Bounds } from '@coderline/alphatab/rendering/utils/Bounds';
import { MasterBarBounds } from '@coderline/alphatab/rendering/utils/MasterBarBounds';
import { NoteBounds } from '@coderline/alphatab/rendering/utils/NoteBounds';
import { StaffSystemBounds } from '@coderline/alphatab/rendering/utils/StaffSystemBounds';

type CompactBounds = [number, number, number, number];
type CompactNoteBounds = [number, CompactBounds];
type CompactBeatBounds = [CompactBounds, CompactBounds, number, number, number, number, number, number, CompactNoteBounds[] | null];
type CompactBarBounds = [CompactBounds, CompactBounds, CompactBeatBounds[]];
type CompactMasterBarBounds = [number, boolean, CompactBounds, CompactBounds, CompactBounds, CompactBarBounds[] | null];
type CompactStaffSystemBounds = [CompactBounds, CompactBounds, CompactMasterBarBounds[]];

/**
 * Compact worker-transfer representation of a complete or partial bounds lookup.
 * @internal
 */
export type CompactBoundsLookup = CompactStaffSystemBounds[];

/**
 * @public
 */
export class BoundsLookup {
    public toCompactJson(firstChangedMasterBar?: number, lastChangedMasterBar?: number): CompactBoundsLookup {
        return this.staffSystems.map((staffSystem): CompactStaffSystemBounds => [
            BoundsLookup._boundsToCompactJson(staffSystem.visualBounds),
            BoundsLookup._boundsToCompactJson(staffSystem.realBounds),
            staffSystem.bars.map((masterBar): CompactMasterBarBounds => {
                const includeNestedBounds = firstChangedMasterBar === undefined || lastChangedMasterBar === undefined || (masterBar.index >= firstChangedMasterBar && masterBar.index <= lastChangedMasterBar);
                return [
                    masterBar.index,
                    masterBar.isFirstOfLine,
                    BoundsLookup._boundsToCompactJson(masterBar.lineAlignedBounds),
                    BoundsLookup._boundsToCompactJson(masterBar.visualBounds),
                    BoundsLookup._boundsToCompactJson(masterBar.realBounds),
                    includeNestedBounds ? masterBar.bars.map((bar): CompactBarBounds => [
                        BoundsLookup._boundsToCompactJson(bar.visualBounds),
                        BoundsLookup._boundsToCompactJson(bar.realBounds),
                        bar.beats.map((beat): CompactBeatBounds => [
                            BoundsLookup._boundsToCompactJson(beat.visualBounds),
                            BoundsLookup._boundsToCompactJson(beat.realBounds),
                            beat.onNotesX,
                            beat.beat.index,
                            beat.beat.voice.index,
                            beat.beat.voice.bar.index,
                            beat.beat.voice.bar.staff.index,
                            beat.beat.voice.bar.staff.track.index,
                            beat.notes?.map((note): CompactNoteBounds => [note.note.index, BoundsLookup._boundsToCompactJson(note.noteHeadBounds)]) ?? null
                        ])
                    ]) : null
                ];
            })
        ]);
    }

    public static fromCompactJson(json: CompactBoundsLookup | null, score: Score, existingLookup: BoundsLookup | null = null): BoundsLookup | null {
        if (json === null) {
            return null;
        }
        if (existingLookup) {
            return existingLookup._applyCompactJsonDelta(json, score);
        }

        const lookup = new BoundsLookup();
        for (const staffSystemData of json) {
            const staffSystemBounds = new StaffSystemBounds();
            staffSystemBounds.visualBounds = BoundsLookup._boundsFromCompactJson(staffSystemData[0]);
            staffSystemBounds.realBounds = BoundsLookup._boundsFromCompactJson(staffSystemData[1]);
            lookup.addStaffSystem(staffSystemBounds);
            for (const masterBarData of staffSystemData[2]) {
                const masterBarBounds = new MasterBarBounds();
                masterBarBounds.index = masterBarData[0];
                masterBarBounds.isFirstOfLine = masterBarData[1];
                masterBarBounds.lineAlignedBounds = BoundsLookup._boundsFromCompactJson(masterBarData[2]);
                masterBarBounds.visualBounds = BoundsLookup._boundsFromCompactJson(masterBarData[3]);
                masterBarBounds.realBounds = BoundsLookup._boundsFromCompactJson(masterBarData[4]);
                lookup.addMasterBar(masterBarBounds);
                for (const barData of masterBarData[5] ?? []) {
                    const barBounds = new BarBounds();
                    barBounds.visualBounds = BoundsLookup._boundsFromCompactJson(barData[0]);
                    barBounds.realBounds = BoundsLookup._boundsFromCompactJson(barData[1]);
                    masterBarBounds.addBar(barBounds);
                    for (const beatData of barData[2]) {
                        const beatBounds = new BeatBounds();
                        beatBounds.visualBounds = BoundsLookup._boundsFromCompactJson(beatData[0]);
                        beatBounds.realBounds = BoundsLookup._boundsFromCompactJson(beatData[1]);
                        beatBounds.onNotesX = beatData[2];
                        beatBounds.beat = score.tracks[beatData[7]].staves[beatData[6]].bars[beatData[5]].voices[beatData[4]].beats[beatData[3]];
                        if (beatData[8]) {
                            for (const noteData of beatData[8]) {
                                const noteBounds = new NoteBounds();
                                noteBounds.note = beatBounds.beat.notes[noteData[0]];
                                noteBounds.noteHeadBounds = BoundsLookup._boundsFromCompactJson(noteData[1]);
                                beatBounds.addNote(noteBounds);
                            }
                        }
                        barBounds.addBeat(beatBounds);
                    }
                }
            }
        }
        for (const staffSystemBounds of lookup.staffSystems) {
            staffSystemBounds.isFinished = true;
        }
        lookup.isFinished = true;
        return lookup;
    }

    private _applyCompactJsonDelta(json: CompactBoundsLookup, score: Score): BoundsLookup {
        for (let staffSystemIndex = 0; staffSystemIndex < json.length; staffSystemIndex++) {
            const staffSystemData = json[staffSystemIndex];
            const staffSystemBounds = this.staffSystems[staffSystemIndex];
            if (!staffSystemBounds) {
                continue;
            }
            BoundsLookup._copyCompactBounds(staffSystemBounds.visualBounds, staffSystemData[0]);
            BoundsLookup._copyCompactBounds(staffSystemBounds.realBounds, staffSystemData[1]);
            for (const masterBarData of staffSystemData[2]) {
                const previousMasterBarBounds = this.findMasterBarByIndex(masterBarData[0]);
                if (!previousMasterBarBounds) {
                    continue;
                }
                if (masterBarData[5] === null) {
                    const offsetX = masterBarData[4][0] - previousMasterBarBounds.realBounds.x;
                    const offsetY = masterBarData[4][1] - previousMasterBarBounds.realBounds.y;
                    if (offsetX !== 0 || offsetY !== 0) {
                        for (const barBounds of previousMasterBarBounds.bars) {
                            BoundsLookup._shiftBounds(barBounds.visualBounds, offsetX, offsetY);
                            BoundsLookup._shiftBounds(barBounds.realBounds, offsetX, offsetY);
                            for (const beatBounds of barBounds.beats) {
                                BoundsLookup._shiftBounds(beatBounds.visualBounds, offsetX, offsetY);
                                BoundsLookup._shiftBounds(beatBounds.realBounds, offsetX, offsetY);
                                beatBounds.onNotesX += offsetX;
                                for (const noteBounds of beatBounds.notes ?? []) {
                                    BoundsLookup._shiftBounds(noteBounds.noteHeadBounds, offsetX, offsetY);
                                }
                            }
                        }
                    }
                    previousMasterBarBounds.isFirstOfLine = masterBarData[1];
                    BoundsLookup._copyCompactBounds(previousMasterBarBounds.lineAlignedBounds, masterBarData[2]);
                    BoundsLookup._copyCompactBounds(previousMasterBarBounds.visualBounds, masterBarData[3]);
                    BoundsLookup._copyCompactBounds(previousMasterBarBounds.realBounds, masterBarData[4]);
                    continue;
                }

                for (const barBounds of previousMasterBarBounds.bars) {
                    for (const beatBounds of barBounds.beats) {
                        const registeredBounds = this._beatLookup.get(beatBounds.beat.id);
                        if (!registeredBounds) {
                            continue;
                        }
                        const remainingBounds = registeredBounds.filter(registeredBound => registeredBound !== beatBounds);
                        if (remainingBounds.length === 0) {
                            this._beatLookup.delete(beatBounds.beat.id);
                        } else {
                            this._beatLookup.set(beatBounds.beat.id, remainingBounds);
                        }
                    }
                }

                const replacementLookup = BoundsLookup.fromCompactJson([[staffSystemData[0], staffSystemData[1], [masterBarData]]], score);
                const replacementMasterBarBounds = replacementLookup?.staffSystems[0]?.bars[0];
                const masterBarPosition = staffSystemBounds.bars.indexOf(previousMasterBarBounds);
                if (!replacementMasterBarBounds || masterBarPosition < 0) {
                    continue;
                }
                replacementMasterBarBounds.staffSystemBounds = staffSystemBounds;
                staffSystemBounds.bars[masterBarPosition] = replacementMasterBarBounds;
                this._masterBarLookup.set(replacementMasterBarBounds.index, replacementMasterBarBounds);
                for (const barBounds of replacementMasterBarBounds.bars) {
                    for (const beatBounds of barBounds.beats) {
                        this.addBeat(beatBounds);
                    }
                }
            }
        }
        return this;
    }

    private static _copyCompactBounds(bounds: Bounds, boundsRaw: CompactBounds): void {
        bounds.x = boundsRaw[0];
        bounds.y = boundsRaw[1];
        bounds.w = boundsRaw[2];
        bounds.h = boundsRaw[3];
    }

    private static _shiftBounds(bounds: Bounds, offsetX: number, offsetY: number): void {
        bounds.x += offsetX;
        bounds.y += offsetY;
    }

    private static _boundsFromCompactJson(boundsRaw: CompactBounds): Bounds {
        const bounds = new Bounds();
        BoundsLookup._copyCompactBounds(bounds, boundsRaw);
        return bounds;
    }

    private static _boundsToCompactJson(bounds: Bounds): CompactBounds {
        return [bounds.x, bounds.y, bounds.w, bounds.h];
    }

    public toJson(): Map<string, unknown> {
        const json = new Map<string, unknown>();
        const systems: Map<string, unknown>[] = [];
        json.set('staffSystems', systems);
        for (const system of this.staffSystems) {
            const g = new Map<string, unknown>();
            g.set('visualBounds', BoundsLookup._boundsToJson(system.visualBounds));
            g.set('realBounds', BoundsLookup._boundsToJson(system.realBounds));
            const gBars: Map<string, unknown>[] = [];
            g.set('bars', gBars);

            for (const masterBar of system.bars) {
                const mb = new Map<string, unknown>();
                mb.set('lineAlignedBounds', BoundsLookup._boundsToJson(masterBar.lineAlignedBounds));
                mb.set('visualBounds', BoundsLookup._boundsToJson(masterBar.visualBounds));
                mb.set('realBounds', BoundsLookup._boundsToJson(masterBar.realBounds));
                mb.set('index', masterBar.index);
                mb.set('isFirstOfLine', masterBar.isFirstOfLine);
                const mbBars: Map<string, unknown>[] = [];
                mb.set('bars', mbBars);
                for (const bar of masterBar.bars) {
                    const b = new Map<string, unknown>();
                    b.set('visualBounds', BoundsLookup._boundsToJson(bar.visualBounds));
                    b.set('realBounds', BoundsLookup._boundsToJson(bar.realBounds));
                    const bBeats: Map<string, unknown>[] = [];
                    b.set('beats', bBeats);
                    for (const beat of bar.beats) {
                        const bb = new Map<string, unknown>();
                        bb.set('visualBounds', BoundsLookup._boundsToJson(beat.visualBounds));
                        bb.set('realBounds', BoundsLookup._boundsToJson(beat.realBounds));
                        bb.set('onNotesX', beat.onNotesX);
                        bb.set('beatIndex', beat.beat.index);
                        bb.set('voiceIndex', beat.beat.voice.index);
                        bb.set('barIndex', beat.beat.voice.bar.index);
                        bb.set('staffIndex', beat.beat.voice.bar.staff.index);
                        bb.set('trackIndex', beat.beat.voice.bar.staff.track.index);
                        if (beat.notes) {
                            const notes: Map<string, unknown>[] = [];
                            bb.set('notes', notes);
                            for (const note of beat.notes) {
                                const n = new Map<string, unknown>();
                                n.set('index', note.note.index);
                                n.set('noteHeadBounds', BoundsLookup._boundsToJson(note.noteHeadBounds));
                                notes.push(n);
                            }
                        }
                        bBeats.push(bb);
                    }
                    mbBars.push(b);
                }
                gBars.push(mb);
            }
            systems.push(g);
        }
        return json;
    }

    public static fromJson(json: Map<string, unknown> | null, score: Score): BoundsLookup | null {
        if (json === null) {
            return null;
        }
        const lookup: BoundsLookup = new BoundsLookup();
        const staffSystems = json.get('staffSystems')! as Map<string, unknown>[];
        for (const staffSystem of staffSystems) {
            const sg: StaffSystemBounds = new StaffSystemBounds();
            sg.visualBounds = BoundsLookup._boundsFromJson(staffSystem.get('visualBounds') as Map<string, unknown>);
            sg.realBounds = BoundsLookup._boundsFromJson(staffSystem.get('realBounds') as Map<string, unknown>);
            lookup.addStaffSystem(sg);
            for (const masterBar of staffSystem.get('bars') as Map<string, unknown>[]) {
                const mb: MasterBarBounds = new MasterBarBounds();
                mb.index = masterBar.get('index') as number;
                mb.isFirstOfLine = masterBar.get('isFirstOfLine') as boolean;
                mb.lineAlignedBounds = BoundsLookup._boundsFromJson(
                    masterBar.get('lineAlignedBounds') as Map<string, unknown>
                );
                mb.visualBounds = BoundsLookup._boundsFromJson(masterBar.get('visualBounds') as Map<string, unknown>);
                mb.realBounds = BoundsLookup._boundsFromJson(masterBar.get('realBounds') as Map<string, unknown>);
                lookup.addMasterBar(mb);
                for (const bar of masterBar.get('bars') as Map<string, unknown>[]) {
                    const b: BarBounds = new BarBounds();
                    b.visualBounds = BoundsLookup._boundsFromJson(bar.get('visualBounds') as Map<string, unknown>);
                    b.realBounds = BoundsLookup._boundsFromJson(bar.get('realBounds') as Map<string, unknown>);
                    mb.addBar(b);
                    for (const beat of bar.get('beats') as Map<string, unknown>[]) {
                        const bb: BeatBounds = new BeatBounds();
                        bb.visualBounds = BoundsLookup._boundsFromJson(
                            beat.get('visualBounds') as Map<string, unknown>
                        );
                        bb.realBounds = BoundsLookup._boundsFromJson(beat.get('realBounds') as Map<string, unknown>);
                        bb.onNotesX = beat.get('onNotesX') as number;
                        bb.beat =
                            score.tracks[beat.get('trackIndex') as number].staves[
                                beat.get('staffIndex') as number
                            ].bars[beat.get('barIndex') as number].voices[beat.get('voiceIndex') as number].beats[
                                beat.get('beatIndex') as number
                            ];
                        if (beat.has('notes')) {
                            bb.notes = [];
                            for (const note of beat.get('notes') as Map<string, unknown>[]) {
                                const n: NoteBounds = new NoteBounds();
                                n.note = bb.beat.notes[note.get('index') as number];
                                n.noteHeadBounds = BoundsLookup._boundsFromJson(
                                    note.get('noteHeadBounds') as Map<string, unknown>
                                );
                                bb.addNote(n);
                            }
                        }
                        b.addBeat(bb);
                    }
                }
            }
        }
        return lookup;
    }

    private static _boundsFromJson(boundsRaw: Map<string, unknown>): Bounds {
        const b = new Bounds();
        b.x = boundsRaw.get('x') as number;
        b.y = boundsRaw.get('y') as number;
        b.w = boundsRaw.get('w') as number;
        b.h = boundsRaw.get('h') as number;
        return b;
    }

    private static _boundsToJson(bounds: Bounds): Map<string, unknown> {
        const json = new Map<string, unknown>();
        json.set('x', bounds.x);
        json.set('y', bounds.y);
        json.set('w', bounds.w);
        json.set('h', bounds.h);
        return json;
    }

    private _beatLookup: Map<number, BeatBounds[]> = new Map();
    private _masterBarLookup: Map<number, MasterBarBounds> = new Map();
    private _currentStaffSystem: StaffSystemBounds | null = null;
    /**
     * Gets a list of all individual staff systems contained in the rendered music notation.
     */
    public staffSystems: StaffSystemBounds[] = [];

    /**
     * Gets or sets a value indicating whether this lookup was finished already.
     */
    public isFinished: boolean = false;

    /**
     * Finishes the lookup for optimized access.
     */
    public finish(scale: number = 1): void {
        for (const t of this.staffSystems) {
            t.finish(scale);
        }
        this.isFinished = true;
    }

    /**
     * Re-opens the lookup for registrations without discarding previously registered bounds.
     * Used by the renderer when it preserves this lookup across a partial render so that new
     * bounds for the re-layouted range can be added while preserved systems stay intact.
     * @internal
     */
    public resetForPartialUpdate(): void {
        this.isFinished = false;
    }

    /**
     * Removes all entries belonging to the given master bar index and any bars after it.
     * Used before a partial render re-registers bounds for the re-layouted range, so the
     * preserved lookup ends up with only the unchanged entries when registration begins.
     *
     * Assumes the layout aligns its re-layouted range to system boundaries - i.e. the first
     * system to clear starts exactly at `masterBarIndex`. Caller is responsible for passing
     * the first master-bar-index of the first re-layouted system.
     * @internal
     */
    public clearFromMasterBar(masterBarIndex: number): void {
        // drop staff systems whose bars start at or after the cleared range.
        let firstRemovedSystem = -1;
        for (let i = 0; i < this.staffSystems.length; i++) {
            const systemBars = this.staffSystems[i].bars;
            if (systemBars.length > 0 && systemBars[0].index >= masterBarIndex) {
                firstRemovedSystem = i;
                break;
            }
        }
        if (firstRemovedSystem !== -1) {
            this.staffSystems.splice(firstRemovedSystem, this.staffSystems.length - firstRemovedSystem);
        }

        // drop master bar entries at or beyond the cleared range.
        for (const key of Array.from(this._masterBarLookup.keys())) {
            if (key >= masterBarIndex) {
                this._masterBarLookup.delete(key);
            }
        }

        // drop beat entries whose beats belong to cleared bars.
        for (const key of Array.from(this._beatLookup.keys())) {
            const list = this._beatLookup.get(key)!;
            const filtered = list.filter(b => b.beat.voice.bar.index < masterBarIndex);
            if (filtered.length === 0) {
                this._beatLookup.delete(key);
            } else if (filtered.length !== list.length) {
                this._beatLookup.set(key, filtered);
            }
        }

        // drop the in-progress pointer - the next addStaffSystem call will replace it.
        this._currentStaffSystem = null;
    }

    /**
     * Adds a new staff sytem to the lookup.
     * @param bounds The staff system bounds to add.
     */
    public addStaffSystem(bounds: StaffSystemBounds): void {
        bounds.index = this.staffSystems.length;
        bounds.boundsLookup = this;
        this.staffSystems.push(bounds);
        this._currentStaffSystem = bounds;
    }

    /**
     * Adds a new master bar to the lookup.
     * @param bounds The master bar bounds to add.
     */
    public addMasterBar(bounds: MasterBarBounds): void {
        if (!bounds.staffSystemBounds) {
            bounds.staffSystemBounds = this._currentStaffSystem!;
            this._masterBarLookup.set(bounds.index, bounds);
            this._currentStaffSystem!.addBar(bounds);
        } else {
            this._masterBarLookup.set(bounds.index, bounds);
        }
    }

    /**
     * Adds a new beat to the lookup.
     * @param bounds The beat bounds to add.
     */
    public addBeat(bounds: BeatBounds): void {
        if (!this._beatLookup.has(bounds.beat.id)) {
            this._beatLookup.set(bounds.beat.id, []);
        }
        this._beatLookup.get(bounds.beat.id)?.push(bounds);
    }

    /**
     * Tries to find the master bar bounds by a given index.
     * @param index The index of the master bar to find.
     * @returns The master bar bounds if it was rendered, or null if no boundary information is available.
     */
    public findMasterBarByIndex(index: number): MasterBarBounds | null {
        if (this._masterBarLookup.has(index)) {
            return this._masterBarLookup.get(index)!;
        }
        return null;
    }

    /**
     * Tries to find the master bar bounds by a given master bar.
     * @param bar The master bar to find.
     * @returns The master bar bounds if it was rendered, or null if no boundary information is available.
     */
    public findMasterBar(bar: MasterBar): MasterBarBounds | null {
        const id: number = bar.index;
        if (this._masterBarLookup.has(id)) {
            return this._masterBarLookup.get(id)!;
        }
        return null;
    }

    /**
     * Tries to find the bounds of a given beat.
     * @param beat The beat to find.
     * @returns The beat bounds if it was rendered, or null if no boundary information is available.
     */
    public findBeat(beat: Beat): BeatBounds | null {
        const all = this.findBeats(beat);
        return all ? all[0] : null;
    }

    /**
     * Tries to find the bounds of a given beat.
     * @param beat The beat to find.
     * @returns The beat bounds if it was rendered, or null if no boundary information is available.
     */
    public findBeats(beat: Beat): BeatBounds[] | null {
        const id: number = beat.id;
        if (this._beatLookup.has(id)) {
            return this._beatLookup.get(id)!;
        }
        return null;
    }

    /**
     * Tries to find a beat at the given absolute position.
     * @param x The absolute X-position of the beat to find.
     * @param y The absolute Y-position of the beat to find.
     * @returns The beat found at the given position or null if no beat could be found.
     */
    public getBeatAtPos(x: number, y: number): Beat | null {
        //
        // find a bar which matches in y-axis
        let bottom: number = 0;
        let top: number = this.staffSystems.length - 1;
        let staffSystemIndex: number = -1;
        while (bottom <= top) {
            const middle: number = ((top + bottom) / 2) | 0;
            const system: StaffSystemBounds = this.staffSystems[middle];
            // found?
            if (y >= system.realBounds.y && y <= system.realBounds.y + system.realBounds.h) {
                staffSystemIndex = middle;
                break;
            }
            // search in lower half
            if (y < system.realBounds.y) {
                top = middle - 1;
            } else {
                bottom = middle + 1;
            }
        }
        // no bar found
        if (staffSystemIndex === -1) {
            return null;
        }
        //
        // Find the matching bar in the row
        const staffSystem: StaffSystemBounds = this.staffSystems[staffSystemIndex];
        const bar: MasterBarBounds | null = staffSystem.findBarAtPos(x);
        if (bar) {
            return bar.findBeatAtPos(x);
        }
        return null;
    }

    /**
     * Tries to find the note at the given position using the given beat for fast access.
     * Use {@link findBeat} to find a beat for a given position first.
     * @param beat The beat containing the note.
     * @param x The X-position of the note.
     * @param y The Y-position of the note.
     * @returns The note at the given position within the beat.
     */
    public getNoteAtPos(beat: Beat, x: number, y: number): Note | null {
        const beatBounds = this.findBeats(beat);
        if (beatBounds) {
            for (const b of beatBounds) {
                const note = b.findNoteAtPos(x, y);
                if (note) {
                    return note;
                }
            }
        }
        return null;
    }
}
