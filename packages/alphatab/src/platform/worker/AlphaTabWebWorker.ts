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
    AlphaTabRenderResultState,
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
    private _measurePerformance: boolean = false;
    private _boundsSerializationDurationMs: number = 0;
    private _renderMessageDurationMs: number = 0;
    private _lazyRenderStartedAt: number | null = null;

    public constructor(main: IAlphaTabWorkerGlobalScope<IAlphaTabWorkerMessage>) {
        this._main = main;
        main.addEventListener('message', e => this._handleMessage(e));
    }

    public static init(): void {
        new AlphaTabWebWorker(Environment.getGlobalWorkerScope<IAlphaTabWorkerMessage>());
    }

    private _renderState(): AlphaTabRenderResultState {
        const projectState: Partial<AlphaTabProjectRenderState> = this._projectId === null ? {} : { operationId: this._operationId, projectId: this._projectId, revision: this._revision };
        return this._measurePerformance ? { ...projectState, measurePerformance: true, workerSentAt: performance.timeOrigin + performance.now() } : projectState;
    }

    private _postRenderMessage(message: IAlphaTabWorkerMessage): void {
        const messageStartedAt = this._measurePerformance ? performance.now() : 0;
        this._main.postMessage(message);
        if (this._measurePerformance) {
            this._renderMessageDurationMs += performance.now() - messageStartedAt;
        }
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
                    const workerRenderDurationMs = this._lazyRenderStartedAt === null ? undefined : performance.now() - this._lazyRenderStartedAt;
                    this._postRenderMessage({ ...this._renderState(), cmd: 'alphaTab.partialRenderFinished', result, workerRenderDurationMs });
                });
                this._renderer.partialLayoutFinished.on(result => {
                    this._postRenderMessage({ ...this._renderState(), cmd: 'alphaTab.partialLayoutFinished', result });
                });
                this._renderer.renderFinished.on(result => {
                    this._postRenderMessage({ ...this._renderState(), cmd: 'alphaTab.renderFinished', result });
                });
                this._renderer.postRenderFinished.on(() => {
                    const boundsSerializationStartedAt = this._measurePerformance ? performance.now() : 0;
                    const boundsRange = this._boundsDeltaRange?.useBoundsDelta ? this._boundsDeltaRange : null;
                    const boundsLookup = this._renderer.boundsLookup?.toCompactJson(boundsRange?.firstChangedMasterBar, boundsRange?.lastChangedMasterBar) ?? null;
                    if (this._measurePerformance) {
                        this._boundsSerializationDurationMs += performance.now() - boundsSerializationStartedAt;
                    }
                    this._postRenderMessage({ ...this._renderState(), boundsDelta: boundsRange !== null, boundsLookup, cmd: 'alphaTab.postRenderFinished' });
                });
                this._renderer.preRender.on(resize => {
                    this._postRenderMessage({ ...this._renderState(), cmd: 'alphaTab.preRender', resize });
                });
                this._renderer.error.on(this._error.bind(this));
                break;
            case 'alphaTab.render':
                this._measurePerformance = data.renderHints?.measurePerformance === true;
                this._renderer.render(data.renderHints);
                break;
            case 'alphaTab.resizeRender':
                this._renderer.resizeRender();
                break;
            case 'alphaTab.renderResult':
                this._lazyRenderStartedAt = this._measurePerformance ? performance.now() : null;
                try {
                    this._renderer.renderResult(data.resultId);
                } finally {
                    this._lazyRenderStartedAt = null;
                }
                break;
            case 'alphaTab.setWidth':
                this._renderer.width = data.width;
                break;
            case 'alphaTab.renderScore':
                const scoreRenderStartedAt = data.renderHints?.measurePerformance ? performance.now() : 0;
                this._measurePerformance = data.renderHints?.measurePerformance === true;
                this._boundsSerializationDurationMs = 0;
                this._renderMessageDurationMs = 0;
                this._boundsDeltaRange = null;
                this._updateFontSizes(data.fontSizes);
                const renderHints = data.renderHints;
                const score =
                    data.score == null ? null : JsonConverter.jsObjectToScore(data.score, this._renderer.settings);
                const scoreModelPreparedAt = this._measurePerformance ? performance.now() : 0;
                this._renderMultiple(score, data.trackIndexes, renderHints);
                this._logCompleteRenderPerformance('score', scoreRenderStartedAt, scoreModelPreparedAt);
                break;
            case 'alphaTab.renderTrackIndexes':
                const trackRenderStartedAt = data.renderHints?.measurePerformance ? performance.now() : 0;
                this._measurePerformance = data.renderHints?.measurePerformance === true;
                this._boundsSerializationDurationMs = 0;
                this._renderMessageDurationMs = 0;
                this._boundsDeltaRange = null;
                const trackModelPreparedAt = this._measurePerformance ? performance.now() : 0;
                this._renderMultiple(this._renderer.score, data.trackIndexes, data.renderHints);
                this._logCompleteRenderPerformance('track indexes', trackRenderStartedAt, trackModelPreparedAt);
                break;
            case 'alphaTab.renderProjectScore':
                const projectRenderStartedAt = data.renderHints?.measurePerformance ? performance.now() : 0;
                this._operationId = null;
                this._projectId = data.projectId;
                this._revision = data.revision;
                this._measurePerformance = data.renderHints?.measurePerformance === true;
                this._boundsSerializationDurationMs = 0;
                this._renderMessageDurationMs = 0;
                this._boundsDeltaRange = null;
                this._updateFontSizes(data.fontSizes);
                const projectScore = data.score == null ? null : JsonConverter.jsObjectToScore(data.score, this._renderer.settings);
                const projectModelPreparedAt = this._measurePerformance ? performance.now() : 0;
                this._renderMultiple(projectScore, data.trackIndexes, data.renderHints);
                this._logCompleteRenderPerformance('project score', projectRenderStartedAt, projectModelPreparedAt);
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

    private _logCompleteRenderPerformance(label: string, performanceStartedAt: number, modelPreparedAt: number): void {
        if (!this._measurePerformance) {
            return;
        }
        const completedAt = performance.now();
        console.groupCollapsed(`[alphaTab worker performance] ${label}: ${(completedAt - performanceStartedAt).toFixed(2)} ms`);
        console.table([
            { phase: 'score reconstruction', durationMs: Number((modelPreparedAt - performanceStartedAt).toFixed(2)) },
            { phase: 'renderer work and callbacks', durationMs: Number((completedAt - modelPreparedAt - this._boundsSerializationDurationMs - this._renderMessageDurationMs).toFixed(2)) },
            { phase: 'bounds serialization', durationMs: Number(this._boundsSerializationDurationMs.toFixed(2)) },
            { phase: 'worker message cloning', durationMs: Number(this._renderMessageDurationMs.toFixed(2)) },
            { phase: 'worker total', durationMs: Number((completedAt - performanceStartedAt).toFixed(2)) }
        ]);
        console.groupEnd();
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
            const performanceStartedAt = data.measurePerformance ? performance.now() : 0;
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
            const modelUpdatedAt = data.measurePerformance ? performance.now() : 0;
            if (data.localFinish) {
                this._finishProjectBars(replacements);
            } else {
                score.finish(this._renderer.settings);
            }
            const finishCompletedAt = data.measurePerformance ? performance.now() : 0;
            this._operationId = data.operationId;
            this._revision = data.revision;
            this._measurePerformance = data.measurePerformance === true;
            this._boundsSerializationDurationMs = 0;
            this._renderMessageDurationMs = 0;
            const renderHints = { ...data.renderHints, measurePerformance: this._measurePerformance };
            this._boundsDeltaRange = renderHints;
            this._renderMultiple(score, data.selectedTrackIndexes, renderHints);
            if (data.measurePerformance) {
                const renderCompletedAt = performance.now();
                console.groupCollapsed(`[alphaTab worker performance] operation ${data.operationId}: ${(renderCompletedAt - performanceStartedAt).toFixed(2)} ms`);
                console.table([
                    { phase: 'bar restore and relink', durationMs: Number((modelUpdatedAt - performanceStartedAt).toFixed(2)) },
                    { phase: 'local score finish', durationMs: Number((finishCompletedAt - modelUpdatedAt).toFixed(2)) },
                    { phase: 'renderer work and callbacks', durationMs: Number((renderCompletedAt - finishCompletedAt - this._boundsSerializationDurationMs - this._renderMessageDurationMs).toFixed(2)) },
                    { phase: 'bounds serialization', durationMs: Number(this._boundsSerializationDurationMs.toFixed(2)) },
                    { phase: 'worker message cloning', durationMs: Number(this._renderMessageDurationMs.toFixed(2)) },
                    { phase: 'worker total', durationMs: Number((renderCompletedAt - performanceStartedAt).toFixed(2)) }
                ]);
                console.groupEnd();
            }
        } catch (error) {
            this._error(error as Error);
        }
    }

    private _error(error: Error): void {
        Logger.error('Worker', 'An unexpected error occurred in worker', error);
        this._postRenderMessage({ ...this._renderState(), cmd: 'alphaTab.error', error });
    }
}
