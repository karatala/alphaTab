import { Environment } from '@coderline/alphatab/Environment';
import {
    EventEmitter,
    EventEmitterOfT,
    type IEventEmitter,
    type IEventEmitterOfT
} from '@coderline/alphatab/EventEmitter';
import { LayoutMode } from '@coderline/alphatab/LayoutMode';
import { Logger } from '@coderline/alphatab/Logger';
import type { Score } from '@coderline/alphatab/model/Score';
import type { Track } from '@coderline/alphatab/model/Track';
import type { ICanvas } from '@coderline/alphatab/platform/ICanvas';
import { Profiler } from '@coderline/alphatab/profiling/Profiler';
import type { IScoreRenderer, ProjectRenderChange, RenderHints } from '@coderline/alphatab/rendering/IScoreRenderer';
import type { ScoreLayout } from '@coderline/alphatab/rendering/layout/ScoreLayout';
import { RenderFinishedEventArgs } from '@coderline/alphatab/rendering/RenderFinishedEventArgs';
import { BoundsLookup } from '@coderline/alphatab/rendering/utils/BoundsLookup';
import type { Settings } from '@coderline/alphatab/Settings';

/**
 * This is the main wrapper of the rendering engine which
 * can render a single track of a score object into a notation sheet.
 * @public
 */
export class ScoreRenderer implements IScoreRenderer {
    private _switchingTracks: boolean = false;
    private _replayingTrackLayout: boolean = false;

    public get isReplayingTrackLayout(): boolean { return this._replayingTrackLayout; }
    private _trackLayouts: Map<number, { layout: ScoreLayout; bounds: BoundsLookup; width: number }> = new Map();

    private _currentLayoutMode: LayoutMode = LayoutMode.Page;
    private _currentRenderEngine: string | null = null;
    private _renderedTracks: Track[] | null = null;

    public canvas: ICanvas | null = null;
    public score: Score | null = null;
    public tracks: Track[] | null = null;
    /**
     * @internal
     */
    public layout: ScoreLayout | null = null;
    public settings: Settings;
    public boundsLookup: BoundsLookup | null = null;
    public width: number = 0;

    /**
     * Initializes a new instance of the {@link ScoreRenderer} class.
     * @param settings The settings to use for rendering.
     */
    public constructor(settings: Settings) {
        this.settings = settings;
        this._recreateCanvas();
        this._recreateLayout();
    }

    public destroy(): void {
        this._trackLayouts.clear();
        this.score = null;
        this.canvas?.destroy();
        this.canvas = null;
        this.layout = null;
        this.boundsLookup = null;
        this.tracks = null;
    }

    private _recreateCanvas(): boolean {
        if (this._currentRenderEngine !== this.settings.core.engine) {
            this.canvas?.destroy();
            this.canvas = Environment.getRenderEngineFactory(this.settings.core.engine).createCanvas();
            this._currentRenderEngine = this.settings.core.engine;
            return true;
        }
        return false;
    }

    private _recreateLayout(): boolean {
        if (!this.layout || this._currentLayoutMode !== this.settings.display.layoutMode) {
            this.layout = Environment.getLayoutEngineFactory(this.settings.display.layoutMode).createLayout(this);
            this._currentLayoutMode = this.settings.display.layoutMode;
            return true;
        }
        return false;
    }

    public renderScore(score: Score | null, trackIndexes: number[] | null, renderHints?: RenderHints): void {
        try {
            this.score = score;
            let tracks: Track[] | null = null;

            if (score != null && trackIndexes != null) {
                if (!trackIndexes) {
                    tracks = score.tracks.slice(0);
                } else {
                    tracks = [];
                    for (const track of trackIndexes) {
                        if (track >= 0 && track < score.tracks.length) {
                            tracks.push(score.tracks[track]);
                        }
                    }
                }
                if (tracks.length === 0 && score.tracks.length > 0) {
                    tracks.push(score.tracks[0]);
                }
            }

            this.tracks = tracks;
            this.render(renderHints);
        } catch (e) {
            (this.error as EventEmitterOfT<Error>).trigger(e as Error);
        }
    }

    public renderTrackIndexes(trackIndexes: number[] | null, renderHints?: RenderHints): void {
        this._switchingTracks = true;
        try {
            this.renderScore(this.score, trackIndexes, renderHints);
        } finally {
            this._switchingTracks = false;
        }
    }

    public renderProjectScore(score: Score | null, trackIndexes: number[] | null, _projectId: string, _revision: number, renderHints?: RenderHints): void {
        this.renderScore(score, trackIndexes, renderHints);
    }

    public renderProjectChange(score: Score | null, trackIndexes: number[] | null, _change: ProjectRenderChange, renderHints: RenderHints): void {
        this.renderScore(score, trackIndexes, renderHints);
    }

    /**
     * Initiates rendering fof the given tracks.
     * @param tracks The tracks to render.
     */
    public renderTracks(tracks: Track[]): void {
        if (tracks.length === 0) {
            this.score = null;
        } else {
            this.score = tracks[0].score;
        }
        this.tracks = tracks;
        this.render();
    }

    public updateSettings(settings: Settings): void {
        this._trackLayouts.clear();
        this.settings = settings;
    }

    public renderResult(resultId: string): void {
        try {
            const layout = this.layout;
            if (layout) {
                Logger.debug('Rendering', `Request render of lazy partial ${resultId}`);
                layout.renderLazyPartial(resultId);
            } else {
                Logger.warning('Rendering', `Request render of lazy partial ${resultId} ignored, no layout exists`);
            }
        } catch (e) {
            (this.error as EventEmitterOfT<Error>).trigger(e as Error);
        }
    }

    public render(renderHints?: RenderHints): void {
        if (!this._switchingTracks || renderHints?.firstChangedMasterBar !== undefined) this._trackLayouts.clear();
        const trackIndex = this.tracks?.length === 1 ? this.tracks[0].index : null;
        const cached = this._switchingTracks && trackIndex !== null ? this._trackLayouts.get(trackIndex) : undefined;
        if (cached && cached.width === this.width) {
            this.layout = cached.layout;
            this.boundsLookup = cached.bounds;
            this._renderedTracks = this.tracks;
            this._trackLayouts.delete(trackIndex!);
            this._trackLayouts.set(trackIndex!, cached);
            (this.preRender as EventEmitterOfT<boolean>).trigger(false);
            this._replayingTrackLayout = true;
            try {
                this.layout.replayLazyLayout();
            } finally {
                this._replayingTrackLayout = false;
            }
            this._onRenderFinished(false);
            (this.postRenderFinished as EventEmitter).trigger();
            if (renderHints?.measurePerformance) console.info('[alphaTab track layout cache] hit', trackIndex);
            return;
        }
        if (this._switchingTracks) {
            this.layout = null;
            if (renderHints?.measurePerformance) console.info('[alphaTab track layout cache] miss', trackIndex);
        }
        Profiler.begin('render.total');
        if (this.width === 0) {
            Logger.warning('Rendering', 'AlphaTab skipped rendering because of width=0 (element invisible)', null);
            Profiler.end('render.total');
            return;
        }
        // For partial renders we preserve the existing lookup so bars outside the re-layouted
        // range keep their already-scaled bounds - the layout will clear the changed range
        // before the paint pass re-registers fresh entries for it.
        if (renderHints?.firstChangedMasterBar !== undefined && this.boundsLookup) {
            this.boundsLookup.resetForPartialUpdate();
        } else {
            this.boundsLookup = new BoundsLookup();
        }
        this._recreateCanvas();
        this.canvas!.lineWidth = 1;
        this.canvas!.settings = this.settings;

        if (!this.tracks || this.tracks.length === 0 || !this.score) {
            Logger.debug('Rendering', 'Clearing rendered tracks because no score or tracks are set');
            (this.preRender as EventEmitterOfT<boolean>).trigger(false);
            this._renderedTracks = null;
            this._onRenderFinished();
            (this.postRenderFinished as EventEmitter).trigger();
            Logger.debug('Rendering', 'Clearing finished');
        } else {
            Logger.debug('Rendering', `Rendering ${this.tracks.length} tracks`);
            for (let i: number = 0; i < this.tracks.length; i++) {
                const track: Track = this.tracks[i];
                Logger.debug('Rendering', `Track ${i}: ${track.name}`);
            }
            (this.preRender as EventEmitterOfT<boolean>).trigger(false);
            this._recreateLayout();
            this._layoutAndRender(renderHints);
            Logger.debug('Rendering', 'Rendering finished');
        }
        Profiler.end('render.total');
    }

    public resizeRender(): void {
        this._trackLayouts.clear();
        Profiler.begin('resize.total');
        if (this._recreateLayout() || this._recreateCanvas() || this._renderedTracks !== this.tracks || !this.tracks) {
            Logger.debug('Rendering', 'Starting full rerendering due to layout or canvas change', null);
            this.render();
        } else if (this.layout!.supportsResize) {
            Logger.debug('Rendering', 'Starting optimized rerendering for resize');
            this.boundsLookup = new BoundsLookup();
            (this.preRender as EventEmitterOfT<boolean>).trigger(true);
            this.canvas!.settings = this.settings;
            Profiler.begin('resize.layoutResize');
            this.layout!.resize();
            Profiler.end('resize.layoutResize');
            this._onRenderFinished();
            (this.postRenderFinished as EventEmitter).trigger();
        } else {
            Logger.debug('Rendering', 'Current layout does not support dynamic resizing, nothing was done', null);
        }
        Logger.debug('Rendering', 'Resize finished');
        Profiler.end('resize.total');
    }

    private _layoutAndRender(renderHints?: RenderHints): void {
        Logger.debug(
            'Rendering',
            `Rendering at scale ${this.settings.display.scale} with layout ${this.layout!.name}`,
            null
        );
        Profiler.begin('render.layoutAndRender');
        this.layout!.layoutAndRender(renderHints);
        Profiler.end('render.layoutAndRender');
        this._renderedTracks = this.tracks;
        this._onRenderFinished();
        if (this.tracks?.length === 1 && this.settings.core.enableLazyLoading && this.boundsLookup && this.layout) {
            this._trackLayouts.set(this.tracks[0].index, { layout: this.layout, bounds: this.boundsLookup, width: this.width });
            while (this._trackLayouts.size > 4) this._trackLayouts.delete(this._trackLayouts.keys().next().value!);
        }
        (this.postRenderFinished as EventEmitter).trigger();
    }

    public readonly preRender: IEventEmitterOfT<boolean> = new EventEmitterOfT<boolean>();
    public readonly renderFinished: IEventEmitterOfT<RenderFinishedEventArgs> =
        new EventEmitterOfT<RenderFinishedEventArgs>();
    public readonly partialRenderFinished: IEventEmitterOfT<RenderFinishedEventArgs> =
        new EventEmitterOfT<RenderFinishedEventArgs>();
    public readonly partialLayoutFinished: IEventEmitterOfT<RenderFinishedEventArgs> =
        new EventEmitterOfT<RenderFinishedEventArgs>();
    public readonly postRenderFinished: IEventEmitter = new EventEmitter();
    public readonly error: IEventEmitterOfT<Error> = new EventEmitterOfT<Error>();

    private _onRenderFinished(finishBounds: boolean = true) {
        if (finishBounds) this.boundsLookup?.finish(this.settings.display.scale);
        const e = new RenderFinishedEventArgs();
        e.totalHeight = this.layout!.height;
        e.totalWidth = this.layout!.width;
        e.renderResult = this.canvas!.onRenderFinished();
        (this.renderFinished as EventEmitterOfT<RenderFinishedEventArgs>).trigger(e);
    }
}
