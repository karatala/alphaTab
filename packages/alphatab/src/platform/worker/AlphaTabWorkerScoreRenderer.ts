import type { AlphaTabApiBase } from '@coderline/alphatab/AlphaTabApiBase';
import { Environment } from '@coderline/alphatab/Environment';
import {
    EventEmitter,
    EventEmitterOfT,
    type IEventEmitter,
    type IEventEmitterOfT
} from '@coderline/alphatab/EventEmitter';
import { JsonConverter } from '@coderline/alphatab/model/JsonConverter';
import type { Score } from '@coderline/alphatab/model/Score';
import { BarSerializer } from '@coderline/alphatab/generated/model/BarSerializer';
import { FontSizes } from '@coderline/alphatab/platform/svg/FontSizes';
import type {
    IAlphaTabRenderingWorker,
    IAlphaTabWorkerMessage
} from '@coderline/alphatab/platform/worker/AlphaTabWorkerProtocol';
import type { IScoreRenderer, ProjectRenderChange, RenderHints } from '@coderline/alphatab/rendering/IScoreRenderer';
import type { RenderFinishedEventArgs } from '@coderline/alphatab/rendering/RenderFinishedEventArgs';
import { BoundsLookup } from '@coderline/alphatab/rendering/utils/BoundsLookup';
import type { Settings } from '@coderline/alphatab/Settings';

interface ProjectRenderState {
    operationId: number | null;
    projectId: string;
    renderHints: RenderHints | undefined;
    revision: number;
    trackIndexes: number[] | null;
}

interface PendingProjectRenderChange {
    change: ProjectRenderChange;
    renderHints: RenderHints;
    score: Score | null;
    trackIndexes: number[] | null;
}

/**
 * @internal
 */
export class AlphaTabWorkerScoreRenderer<T> implements IScoreRenderer {
    private _api: AlphaTabApiBase<T>;
    private _worker!: IAlphaTabRenderingWorker;
    private _width: number = 0;
    private _pendingProjectChange: PendingProjectRenderChange | null = null;
    private _projectRenderInFlight: boolean = false;
    private _projectState: ProjectRenderState | null = null;

    public boundsLookup: BoundsLookup | null = null;

    public constructor(api: AlphaTabApiBase<T>, worker: IAlphaTabRenderingWorker) {
        this._api = api;
        this._worker = worker;
        this._worker.postMessage({
            cmd: 'alphaTab.initialize',
            settings: this._serializeSettingsForWorker(api.settings)
        });
        this._worker.addEventListener('message', e => this._handleWorkerMessage(e));
    }

    public destroy(): void {
        this._worker.terminate();
    }

    public updateSettings(settings: Settings): void {
        this._worker.postMessage({
            cmd: 'alphaTab.updateSettings',
            settings: this._serializeSettingsForWorker(settings)
        });
    }

    private _serializeSettingsForWorker(settings: Settings): Map<string, unknown> {
        const jsObject = JsonConverter.settingsToJsObject(Environment.prepareForPostMessage(settings))!;
        // cut out player settings, they are only needed on UI thread side
        jsObject.delete('player');
        return jsObject;
    }

    public render(renderHints?: RenderHints): void {
        this._worker.postMessage({
            cmd: 'alphaTab.render',
            renderHints: renderHints
        });
    }

    public resizeRender(): void {
        this._worker.postMessage({
            cmd: 'alphaTab.resizeRender'
        });
    }

    public renderResult(resultId: string): void {
        this._worker.postMessage({
            cmd: 'alphaTab.renderResult',
            resultId: resultId
        });
    }

    public get width(): number {
        return this._width;
    }

    public set width(value: number) {
        this._width = value;
        this._worker.postMessage({
            cmd: 'alphaTab.setWidth',
            width: value
        });
    }

    private _handleWorkerMessage(e: MessageEvent<IAlphaTabWorkerMessage>): void {
        const data = e.data;
        const state = this._projectState;
        const operationId = 'operationId' in data ? data.operationId : undefined;
        if ('revision' in data && data.revision !== undefined && (!state || state.projectId !== data.projectId || state.revision !== data.revision || state.operationId !== operationId)) {
            return;
        }
        if ('revision' in data && data.revision !== undefined && this._pendingProjectChange && data.cmd !== 'alphaTab.postRenderFinished') {
            return;
        }
        const cmd = data.cmd;
        switch (cmd) {
            case 'alphaTab.preRender':
                (this.preRender as EventEmitterOfT<boolean>).trigger(data.resize);
                break;
            case 'alphaTab.partialRenderFinished':
                const partialRenderMessageStartedAt = data.measurePerformance ? performance.now() : 0;
                (this.partialRenderFinished as EventEmitterOfT<RenderFinishedEventArgs>).trigger(data.result);
                if (data.measurePerformance) {
                    const partialRenderMessageCompletedAt = performance.now();
                    const partialWorkerSentAt = data.workerSentAt ?? performance.timeOrigin + partialRenderMessageStartedAt;
                    const partialWorkerMessageDeliveryDuration = Math.max(0, performance.timeOrigin + partialRenderMessageStartedAt - partialWorkerSentAt);
                    console.groupCollapsed(`[alphaTab lazy performance] operation ${data.operationId}, bars ${data.result.firstMasterBarIndex}-${data.result.lastMasterBarIndex}: ${(partialRenderMessageCompletedAt - partialRenderMessageStartedAt).toFixed(2)} ms main`);
                    console.table([
                        { phase: 'worker SVG render', durationMs: Number((data.workerRenderDurationMs ?? 0).toFixed(2)) },
                        { phase: 'worker message delivery', durationMs: Number(partialWorkerMessageDeliveryDuration.toFixed(2)) },
                        { phase: 'main DOM apply', durationMs: Number((partialRenderMessageCompletedAt - partialRenderMessageStartedAt).toFixed(2)) }
                    ]);
                    console.groupEnd();
                }
                break;
            case 'alphaTab.partialLayoutFinished':
                (this.partialLayoutFinished as EventEmitterOfT<RenderFinishedEventArgs>).trigger(data.result);
                break;
            case 'alphaTab.renderFinished':
                (this.renderFinished as EventEmitterOfT<RenderFinishedEventArgs>).trigger(data.result);
                break;
            case 'alphaTab.postRenderFinished':
                const mainMessageStartedAt = data.measurePerformance ? performance.now() : 0;
                const score = this._api.score;
                const hasPendingChange = this._pendingProjectChange !== null;
                const boundsReconstructionStartedAt = data.measurePerformance ? performance.now() : 0;
                if (!hasPendingChange && score && data.boundsLookup) {
                    this.boundsLookup = BoundsLookup.fromCompactJson(data.boundsLookup, score, data.boundsDelta ? this.boundsLookup : null);
                }
                const boundsReconstructionCompletedAt = data.measurePerformance ? performance.now() : 0;
                const boundsFinalizationCompletedAt = boundsReconstructionCompletedAt;
                this._projectRenderInFlight = false;
                this._dispatchPendingProjectChange();
                const pendingDispatchCompletedAt = data.measurePerformance ? performance.now() : 0;
                if (!hasPendingChange) {
                    (this.postRenderFinished as EventEmitter).trigger();
                }
                if (data.measurePerformance) {
                    const mainMessageCompletedAt = performance.now();
                    const workerSentAt = data.workerSentAt ?? performance.timeOrigin + mainMessageStartedAt;
                    const workerMessageDeliveryDuration = Math.max(0, performance.timeOrigin + mainMessageStartedAt - workerSentAt);
                    console.groupCollapsed(`[alphaTab main performance] operation ${data.operationId}: ${(mainMessageCompletedAt - mainMessageStartedAt).toFixed(2)} ms`);
                    console.table([
                        { phase: 'worker message delivery', durationMs: Number(workerMessageDeliveryDuration.toFixed(2)) },
                        { phase: 'compact bounds reconstruction', durationMs: Number((boundsReconstructionCompletedAt - boundsReconstructionStartedAt).toFixed(2)) },
                        { phase: 'bounds finalization', durationMs: Number((boundsFinalizationCompletedAt - boundsReconstructionCompletedAt).toFixed(2)) },
                        { phase: 'pending render dispatch', durationMs: Number((pendingDispatchCompletedAt - boundsFinalizationCompletedAt).toFixed(2)) },
                        { phase: 'post-render callbacks', durationMs: Number((mainMessageCompletedAt - pendingDispatchCompletedAt).toFixed(2)) },
                        { phase: 'main message total', durationMs: Number((mainMessageCompletedAt - mainMessageStartedAt).toFixed(2)) }
                    ]);
                    console.groupEnd();
                }
                break;
            case 'alphaTab.projectSyncRequired':
                const currentState = this._projectState;
                if (currentState && currentState.projectId === data.projectId && currentState.operationId === data.operationId) {
                    const pendingChange = this._pendingProjectChange;
                    this.renderProjectScore(this._api.score, pendingChange?.trackIndexes ?? currentState.trackIndexes, currentState.projectId, pendingChange?.change.revision ?? currentState.revision, pendingChange?.renderHints ?? currentState.renderHints);
                }
                break;
            case 'alphaTab.error':
                this._pendingProjectChange = null;
                this._projectRenderInFlight = false;
                (this.error as EventEmitterOfT<Error>).trigger(data.error);
                break;
        }
    }

    public renderScore(score: Score | null, trackIndexes: number[] | null, renderHints?: RenderHints): void {
        const jsObject: Map<string, unknown> | null =
            score == null ? null : JsonConverter.scoreToJsObject(Environment.prepareForPostMessage(score));
        this._worker.postMessage({
            cmd: 'alphaTab.renderScore',
            score: jsObject,
            trackIndexes: Environment.prepareForPostMessage(trackIndexes),
            fontSizes: FontSizes.fontSizeLookupTables,
            renderHints
        });
    }

    public renderProjectScore(score: Score | null, trackIndexes: number[] | null, projectId: string, revision: number, renderHints?: RenderHints): void {
        this._pendingProjectChange = null;
        this._projectRenderInFlight = true;
        this._projectState = { operationId: null, projectId, renderHints, revision, trackIndexes };
        const jsObject = score == null ? null : JsonConverter.scoreToJsObject(Environment.prepareForPostMessage(score));
        this._worker.postMessage({
            cmd: 'alphaTab.renderProjectScore',
            fontSizes: FontSizes.fontSizeLookupTables,
            projectId,
            renderHints,
            revision,
            score: jsObject,
            trackIndexes: Environment.prepareForPostMessage(trackIndexes)
        });
    }

    private _postProjectChange(score: Score | null, trackIndexes: number[] | null, change: ProjectRenderChange, renderHints: RenderHints): void {
        const bars = [];
        for (const trackIndex of change.trackIndexes) {
            const track = score?.tracks[trackIndex];
            if (!track) {
                continue;
            }
            for (const staff of track.staves) {
                const lastMasterBar = Math.min(change.lastMasterBar, staff.bars.length - 1);
                for (let barIndex = change.firstMasterBar; barIndex <= lastMasterBar; barIndex++) {
                    bars.push({ bar: BarSerializer.toJson(staff.bars[barIndex])!, barIndex, staffIndex: staff.index, trackIndex });
                }
            }
        }
        this._projectRenderInFlight = true;
        this._projectState = { operationId: change.operationId, projectId: change.projectId, renderHints, revision: change.revision, trackIndexes };
        this._worker.postMessage({ ...change, bars: Environment.prepareForPostMessage(bars), cmd: 'alphaTab.renderProjectChange', renderHints, selectedTrackIndexes: Environment.prepareForPostMessage(trackIndexes) });
    }

    public renderProjectChange(score: Score | null, trackIndexes: number[] | null, change: ProjectRenderChange, renderHints: RenderHints): void {
        if (!this._projectRenderInFlight) {
            this._postProjectChange(score, trackIndexes, change, renderHints);
            return;
        }
        const pendingChange = this._pendingProjectChange;
        const baseRevision = this._projectState?.revision ?? change.previousRevision;
        if (!pendingChange || pendingChange.change.projectId !== change.projectId) {
            this._pendingProjectChange = { change: { ...change, previousRevision: baseRevision }, renderHints, score, trackIndexes };
            return;
        }
        const pendingFirstChangedMasterBar = pendingChange.renderHints.firstChangedMasterBar ?? pendingChange.change.firstMasterBar;
        const pendingLastChangedMasterBar = pendingChange.renderHints.lastChangedMasterBar ?? pendingChange.change.lastMasterBar;
        const firstChangedMasterBar = renderHints.firstChangedMasterBar ?? change.firstMasterBar;
        const lastChangedMasterBar = renderHints.lastChangedMasterBar ?? change.lastMasterBar;
        this._pendingProjectChange = {
            change: {
                ...change,
                firstMasterBar: Math.min(pendingChange.change.firstMasterBar, change.firstMasterBar),
                lastMasterBar: Math.max(pendingChange.change.lastMasterBar, change.lastMasterBar),
                previousRevision: baseRevision,
                trackIndexes: Array.from(new Set([...pendingChange.change.trackIndexes, ...change.trackIndexes]))
            },
            renderHints: {
                ...renderHints,
                firstChangedMasterBar: Math.min(pendingFirstChangedMasterBar, firstChangedMasterBar),
                lastChangedMasterBar: Math.max(pendingLastChangedMasterBar, lastChangedMasterBar)
            },
            score,
            trackIndexes
        };
    }

    private _dispatchPendingProjectChange(): void {
        const pendingChange = this._pendingProjectChange;
        this._pendingProjectChange = null;
        if (pendingChange) {
            this._postProjectChange(pendingChange.score, pendingChange.trackIndexes, pendingChange.change, pendingChange.renderHints);
        }
    }

    public renderTrackIndexes(trackIndexes: number[] | null, renderHints?: RenderHints): void {
        this._worker.postMessage({
            cmd: 'alphaTab.renderTrackIndexes',
            trackIndexes: Environment.prepareForPostMessage(trackIndexes),
            renderHints: renderHints
        });
    }

    public readonly preRender: IEventEmitterOfT<boolean> = new EventEmitterOfT<boolean>();
    public readonly partialRenderFinished: IEventEmitterOfT<RenderFinishedEventArgs> =
        new EventEmitterOfT<RenderFinishedEventArgs>();
    public readonly partialLayoutFinished: IEventEmitterOfT<RenderFinishedEventArgs> =
        new EventEmitterOfT<RenderFinishedEventArgs>();
    public readonly renderFinished: IEventEmitterOfT<RenderFinishedEventArgs> =
        new EventEmitterOfT<RenderFinishedEventArgs>();
    public readonly postRenderFinished: IEventEmitter = new EventEmitter();
    public readonly error: IEventEmitterOfT<Error> = new EventEmitterOfT<Error>();
}
