import { Environment } from '@coderline/alphatab/Environment';
import { SettingsSerializer } from '@coderline/alphatab/generated/SettingsSerializer';
import { BarSerializer } from '@coderline/alphatab/generated/model/BarSerializer';
import { Logger } from '@coderline/alphatab/Logger';
import { Bar } from '@coderline/alphatab/model/Bar';
import { JsonConverter } from '@coderline/alphatab/model/JsonConverter';
import type { Score } from '@coderline/alphatab/model/Score';
import type { Staff } from '@coderline/alphatab/model/Staff';
import { type FontSizeDefinition, FontSizes } from '@coderline/alphatab/platform/svg/FontSizes';
import type {
    AlphaTabProjectRenderState,
    IAlphaTabWorkerGlobalScope,
    IAlphaTabWorkerMessage
} from '@coderline/alphatab/platform/worker/AlphaTabWorkerProtocol';
import type { RenderHints } from '@coderline/alphatab/rendering/IScoreRenderer';
import { ScoreRenderer } from '@coderline/alphatab/rendering/ScoreRenderer';
import type { Settings } from '@coderline/alphatab/Settings';

/**
 * @internal
 * @partial
 */
export class AlphaTabWebWorker {
    private _renderer!: ScoreRenderer;
    private _main: IAlphaTabWorkerGlobalScope<IAlphaTabWorkerMessage>;
    private _operationId: number | null = null;
    private _projectId: string | null = null;
    private _revision: number = -1;
    private _boundsDeltaRange: RenderHints | null = null;

    public constructor(main: IAlphaTabWorkerGlobalScope<IAlphaTabWorkerMessage>) {
        this._main = main;
        main.addEventListener('message', e => this._handleMessage(e));
    }

    public static init(): void {
        new AlphaTabWebWorker(Environment.getGlobalWorkerScope<IAlphaTabWorkerMessage>());
    }

    private _renderState(): Partial<AlphaTabProjectRenderState> {
        return this._projectId === null ? {} : { operationId: this._operationId, projectId: this._projectId, revision: this._revision };
    }

    private _handleMessage(e: MessageEvent<IAlphaTabWorkerMessage>): void {
        const data = e.data;
        if (!data?.cmd) {
            return;
        }
        switch (data.cmd) {
            case 'alphaTab.initialize':
                const settings: Settings = JsonConverter.jsObjectToSettings(data.settings);
                Logger.logLevel = settings.core.logLevel;
                this._renderer = new ScoreRenderer(settings);
                this._renderer.partialRenderFinished.on(result => {
                    this._main.postMessage({ ...this._renderState(), cmd: 'alphaTab.partialRenderFinished', result });
                });
                this._renderer.partialLayoutFinished.on(result => {
                    this._main.postMessage({ ...this._renderState(), cmd: 'alphaTab.partialLayoutFinished', result });
                });
                this._renderer.renderFinished.on(result => {
                    this._main.postMessage({ ...this._renderState(), cmd: 'alphaTab.renderFinished', result });
                });
                this._renderer.postRenderFinished.on(() => {
                    const boundsRange = this._boundsDeltaRange?.useBoundsDelta ? this._boundsDeltaRange : null;
                    const boundsLookup = this._renderer.boundsLookup?.toCompactJson(boundsRange?.firstChangedMasterBar, boundsRange?.lastChangedMasterBar) ?? null;
                    this._main.postMessage({ ...this._renderState(), boundsDelta: boundsRange !== null, boundsLookup, cmd: 'alphaTab.postRenderFinished' });
                });
                this._renderer.preRender.on(resize => {
                    this._main.postMessage({ ...this._renderState(), cmd: 'alphaTab.preRender', resize });
                });
                this._renderer.error.on(this._error.bind(this));
                break;
            case 'alphaTab.render':
                this._renderer.render(data.renderHints);
                break;
            case 'alphaTab.resizeRender':
                this._renderer.resizeRender();
                break;
            case 'alphaTab.renderResult':
                this._renderer.renderResult(data.resultId);
                break;
            case 'alphaTab.setWidth':
                this._renderer.width = data.width;
                break;
            case 'alphaTab.renderScore':
                this._boundsDeltaRange = null;
                this._updateFontSizes(data.fontSizes);
                const renderHints = data.renderHints;
                const score =
                    data.score == null ? null : JsonConverter.jsObjectToScore(data.score, this._renderer.settings);
                this._renderMultiple(score, data.trackIndexes, renderHints);
                break;
            case 'alphaTab.renderTrackIndexes':
                this._boundsDeltaRange = null;
                this._renderMultiple(this._renderer.score, data.trackIndexes, data.renderHints);
                break;
            case 'alphaTab.renderProjectScore':
                this._operationId = null;
                this._projectId = data.projectId;
                this._revision = data.revision;
                this._boundsDeltaRange = null;
                this._updateFontSizes(data.fontSizes);
                this._renderMultiple(data.score == null ? null : JsonConverter.jsObjectToScore(data.score, this._renderer.settings), data.trackIndexes, data.renderHints);
                break;
            case 'alphaTab.renderProjectChange':
                this._applyProjectChange(data);
                break;
            case 'alphaTab.updateSettings':
                this._updateSettings(data.settings);
                break;
        }
    }

    private _updateFontSizes(fontSizes: Map<string, FontSizeDefinition>): void {
        for (const [k, v] of fontSizes) {
            FontSizes.fontSizeLookupTables.set(k, v);
        }
    }

    private _updateSettings(json: unknown): void {
        SettingsSerializer.fromJson(this._renderer.settings, json);
    }

    private _renderMultiple(score: Score | null, trackIndexes: number[] | null, renderHints?: RenderHints): void {
        try {
            this._renderer.renderScore(score, trackIndexes, renderHints);
        } catch (e) {
            this._error(e as Error);
        }
    }

    private _finishProjectBars(replacements: { bar: Bar; barIndex: number; staff: Staff }[]): void {
        const sharedDataBag = new Map<string, unknown>();
        const affectedStaves = new Set<Staff>();
        for (const replacement of replacements) {
            const bar = replacement.bar;
            for (const voice of bar.voices) {
                const firstBeat = voice.beats[0];
                const previousVoice = bar.previousBar?.voices[voice.index];
                const previousBeat = previousVoice?.beats[previousVoice.beats.length - 1];
                if (firstBeat && previousBeat) {
                    firstBeat.previousBeat = previousBeat;
                    previousBeat.nextBeat = firstBeat;
                }
            }
            bar.finish(this._renderer.settings, sharedDataBag);
            affectedStaves.add(replacement.staff);
        }
        for (const staff of affectedStaves) {
            staff.rebuildFilledVoices();
        }
    }

    private _applyProjectChange(data: Extract<IAlphaTabWorkerMessage, { cmd: 'alphaTab.renderProjectChange' }>): void {
        const score = this._renderer.score;
        if (!score || this._projectId !== data.projectId || this._revision !== data.previousRevision) {
            this._main.postMessage({ cmd: 'alphaTab.projectSyncRequired', operationId: data.operationId, projectId: data.projectId });
            return;
        }
        try {
            const replacements: { bar: Bar; barIndex: number; staff: Staff }[] = [];
            for (const entry of data.bars) {
                const staff = score.tracks[entry.trackIndex]?.staves[entry.staffIndex];
                if (!staff || entry.barIndex < 0 || entry.barIndex >= staff.bars.length) {
                    this._main.postMessage({ cmd: 'alphaTab.projectSyncRequired', operationId: data.operationId, projectId: data.projectId });
                    return;
                }
                const bar = new Bar();
                BarSerializer.fromJson(bar, entry.bar);
                replacements.push({ bar, barIndex: entry.barIndex, staff });
            }
            const affectedStaves = new Set<Staff>();
            for (const replacement of replacements) {
                replacement.staff.bars[replacement.barIndex] = replacement.bar;
                affectedStaves.add(replacement.staff);
            }
            for (const staff of affectedStaves) {
                for (let barIndex = 0; barIndex < staff.bars.length; barIndex++) {
                    const bar = staff.bars[barIndex];
                    bar.staff = staff;
                    bar.index = barIndex;
                    bar.previousBar = barIndex > 0 ? staff.bars[barIndex - 1] : null;
                    bar.nextBar = barIndex + 1 < staff.bars.length ? staff.bars[barIndex + 1] : null;
                }
            }
            if (data.localFinish) {
                this._finishProjectBars(replacements);
            } else {
                score.finish(this._renderer.settings);
            }
            this._operationId = data.operationId;
            this._revision = data.revision;
            this._boundsDeltaRange = data.renderHints;
            this._renderMultiple(score, data.selectedTrackIndexes, data.renderHints);
        } catch (error) {
            this._error(error as Error);
        }
    }

    private _error(error: Error): void {
        Logger.error('Worker', 'An unexpected error occurred in worker', error);
        this._main.postMessage({ ...this._renderState(), cmd: 'alphaTab.error', error });
    }
}
