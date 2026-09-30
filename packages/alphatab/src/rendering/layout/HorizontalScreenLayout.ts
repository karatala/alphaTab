import { Logger } from '@coderline/alphatab/Logger';
import type { MasterBar } from '@coderline/alphatab/model/MasterBar';
import type { Score } from '@coderline/alphatab/model/Score';
import { TextAlign } from '@coderline/alphatab/platform/ICanvas';
import type { RenderHints } from '@coderline/alphatab/rendering/IScoreRenderer';
import { ScoreLayout } from '@coderline/alphatab/rendering/layout/ScoreLayout';
import { RenderFinishedEventArgs } from '@coderline/alphatab/rendering/RenderFinishedEventArgs';
import type { MasterBarsRenderers } from '@coderline/alphatab/rendering/staves/MasterBarsRenderers';
import type { StaffSystem } from '@coderline/alphatab/rendering/staves/StaffSystem';

/**
 * @internal
 */
export class HorizontalScreenLayoutPartialInfo {
    public x: number = 0;
    public width: number = 0;
    public masterBars: MasterBar[] = [];
    public results: MasterBarsRenderers[] = [];
}

/**
 * This layout arranges the bars all horizontally
 * @internal
 */
export class HorizontalScreenLayout extends ScoreLayout {
    private _system: StaffSystem | null = null;
    private _systems: StaffSystem[] = [];
    private _cachedMasterBarRenderers: Map<number, MasterBarsRenderers> | null = null;

    public override get systems(): StaffSystem[] {
        return this._systems;
    }

    public get name(): string {
        return 'HorizontalScreen';
    }

    public get supportsResize(): boolean {
        return false;
    }

    public get firstBarX(): number {
        let x = this.pagePadding![0];
        if (this._system) {
            x += this._system.accoladeWidth;
        }
        return x;
    }

    public doResize(): void {
        // not supported
    }

    public override isMasterBarRendererCached(masterBarIndex: number): boolean {
        return this._cachedMasterBarRenderers?.has(masterBarIndex) === true;
    }

    public override doUpdateForBars(renderHints: RenderHints): boolean {
        const firstChangedMasterBar = renderHints.firstChangedMasterBar!;
        const lastChangedMasterBar = renderHints.lastChangedMasterBar;
        if (!this._system || this._system.masterBarsRenderers.length === 0 || lastChangedMasterBar === undefined || !this.renderer.settings.core.enableLazyLoading || this._system.firstBarIndex !== this.firstBarIndex || this._system.lastBarIndex !== this.lastBarIndex) {
            return false;
        }
        if (this._system.allStaves.some(staff => staff.getSharedLayoutData('tab.whammy.offset', null) !== null)) {
            return false;
        }

        renderHints.useBoundsDelta = true;
        this._cachedMasterBarRenderers = new Map<number, MasterBarsRenderers>();
        let expandedFirstChangedMasterBar = firstChangedMasterBar;
        let expandedLastChangedMasterBar = lastChangedMasterBar;
        for (const renderers of this._system.masterBarsRenderers) {
            if (renderers.lastMasterBarIndex < firstChangedMasterBar || renderers.masterBar.index > lastChangedMasterBar) {
                this._cachedMasterBarRenderers.set(renderers.masterBar.index, renderers);
                continue;
            }
            expandedFirstChangedMasterBar = Math.min(expandedFirstChangedMasterBar, renderers.masterBar.index);
            expandedLastChangedMasterBar = Math.max(expandedLastChangedMasterBar, renderers.lastMasterBarIndex);
            for (const renderer of renderers.renderers) {
                const rendererLookup = this._barRendererLookup.get(renderer.staff!.staffId);
                rendererLookup?.delete(renderer.bar.id);
                if (renderer.additionalMultiRestBars) {
                    for (const additionalBar of renderer.additionalMultiRestBars) {
                        rendererLookup?.delete(additionalBar.id);
                    }
                }
            }
        }

        renderHints.firstChangedMasterBar = expandedFirstChangedMasterBar;
        renderHints.lastChangedMasterBar = expandedLastChangedMasterBar;
        this.renderer.boundsLookup!.clearFromMasterBar(0);
        this._lazyPartials.clear();
        this.beamingRuleLookups.clear();
        try {
            this.doLayoutAndRender(renderHints);
        } finally {
            this._cachedMasterBarRenderers = null;
        }
        return true;
    }

    protected doLayoutAndRender(renderHints: RenderHints | undefined): void {
        const performanceStartedAt = renderHints?.measurePerformance ? performance.now() : 0;
        const score: Score = this.renderer.score!;

        let startIndex: number = this.renderer.settings.display.startBar;
        startIndex--; // map to array index

        startIndex = Math.min(score.masterBars.length - 1, Math.max(0, startIndex));
        let currentBarIndex: number = startIndex;
        let endBarIndex: number = this.renderer.settings.display.barCount;
        if (endBarIndex <= 0) {
            endBarIndex = score.masterBars.length;
        }
        endBarIndex = startIndex + endBarIndex - 1; // map count to array index

        endBarIndex = Math.min(score.masterBars.length - 1, Math.max(0, endBarIndex));
        this._system = this.createEmptyStaffSystem(0);
        this._systems.splice(0, this._systems.length);
        this._systems.push(this._system);
        // Each bar in horizontal layout is sized independently (by bar.displayWidth or the bar's
        // intrinsic width), so there is no shared staff width to distribute across bars. Keep each
        // bar's spring constants referenced against its own local minimum-duration so rendering
        // matches the historical per-bar behaviour.
        this._system.shareMinDurationAcrossBars = false;
        this._system.isLast = true;
        this._system.x = this.pagePadding![0];
        this._system.y = this.pagePadding![1];
        const countPerPartial: number = this.renderer.settings.display.barCountPerPartial;
        const partials: HorizontalScreenLayoutPartialInfo[] = [];
        let currentPartial: HorizontalScreenLayoutPartialInfo = new HorizontalScreenLayoutPartialInfo();
        let cachedReattachmentDurationMs = 0;
        let changedRangeLayoutDurationMs = 0;
        let cachedRendererBarCount = 0;
        let changedRangeBarCount = 0;
        while (currentBarIndex <= endBarIndex) {
            const multiBarRestInfo = this.multiBarRestInfo;
            const additionalMultiBarsRestBarIndices: number[] | null =
                multiBarRestInfo !== null && multiBarRestInfo.has(currentBarIndex)
                    ? multiBarRestInfo.get(currentBarIndex)!
                    : null;

            const cachedRenderers = this._cachedMasterBarRenderers?.get(currentBarIndex);
            const barAssemblyStartedAt = renderHints?.measurePerformance ? performance.now() : 0;
            const result = cachedRenderers
                ? this._system.addMasterBarRenderers(this.renderer.tracks!, cachedRenderers, false)!
                : this._system.addBars(this.renderer.tracks!, currentBarIndex, additionalMultiBarsRestBarIndices);
            if (renderHints?.measurePerformance) {
                const barAssemblyDurationMs = performance.now() - barAssemblyStartedAt;
                if (cachedRenderers) {
                    cachedReattachmentDurationMs += barAssemblyDurationMs;
                    cachedRendererBarCount++;
                } else {
                    changedRangeLayoutDurationMs += barAssemblyDurationMs;
                    changedRangeBarCount++;
                }
            }

            // complete partial if its full and we are not linked
            if (currentPartial.masterBars.length >= countPerPartial && !result.isLinkedToPrevious) {
                currentPartial = this._completePartial(partials, currentPartial);
            }

            if (!cachedRenderers) {
                this._scaleBars(result);
            }

            currentPartial.results.push(result);
            currentPartial.masterBars.push(score.masterBars[currentBarIndex]);
            currentPartial.width += result.width;
            currentBarIndex++;
        }

        // don't miss the last partial if not empty
        if (currentPartial.masterBars.length > 0) {
            this._completePartial(partials, currentPartial);
        }
        const assemblyCompletedAt = renderHints?.measurePerformance ? performance.now() : 0;
        this._alignRenderers();
        const alignmentCompletedAt = renderHints?.measurePerformance ? performance.now() : 0;
        this._system.finalizeSystem();
        const finalizationCompletedAt = renderHints?.measurePerformance ? performance.now() : 0;

        this.height = Math.floor(this._system.y + this._system.height);
        this.width = this._system.x + this._system.width + this.pagePadding![2];
        currentBarIndex = 0;

        let x = 0;
        const boundsStartedAt = renderHints?.measurePerformance ? performance.now() : 0;
        this._system.buildBoundingsLookup(0, 0);
        const boundsCompletedAt = renderHints?.measurePerformance ? performance.now() : 0;
        for (let i: number = 0; i < partials.length; i++) {
            const partial: HorizontalScreenLayoutPartialInfo = partials[i];

            const e = new RenderFinishedEventArgs();
            e.reuseViewport = renderHints?.reuseViewport ?? false;
            e.x = x;
            e.y = 0;
            e.totalWidth = this.width;
            e.totalHeight = this.height;
            e.width = partial.width;
            e.height = this.height;
            e.firstMasterBarIndex = partial.masterBars[0].index;
            e.lastMasterBarIndex = partial.masterBars[partial.masterBars.length - 1].index;

            x += partial.width;

            // pull to local scope for lambda
            const partialBarIndex = currentBarIndex;
            const partialIndex = i;
            this.registerPartial(e, canvas => {
                let renderX: number = this._system!.getBarX(partial.masterBars[0].index) + this._system!.accoladeWidth;
                if (partialIndex === 0) {
                    renderX -= this._system!.x + this._system!.accoladeWidth;
                }

                canvas.color = this.renderer.settings.display.resources.mainGlyphColor;
                canvas.textAlign = TextAlign.Left;
                Logger.debug(
                    this.name,
                    `Rendering partial from bar ${partial.masterBars[0].index} to ${partial.masterBars[partial.masterBars.length - 1].index}`,
                    null
                );
                this._system!.paintPartial(
                    -renderX,
                    this._system!.y,
                    canvas,
                    partialBarIndex,
                    partial.masterBars.length
                );
            });

            currentBarIndex += partial.masterBars.length;
        }

        this.height = this.layoutAndRenderBottomScoreInfo(this.height);
        this.height = this._layoutAndRenderAnnotation(this.height);

        this.height += this.pagePadding![3];

        this.height *= this.renderer.settings.display.scale;
        if (renderHints?.measurePerformance) {
            const completedAt = performance.now();
            console.groupCollapsed(`[alphaTab horizontal performance] ${(completedAt - performanceStartedAt).toFixed(2)} ms`);
            console.table([
                { phase: 'system assembly', durationMs: Number((assemblyCompletedAt - performanceStartedAt).toFixed(2)) },
                { phase: 'cached renderer reattachment', barCount: cachedRendererBarCount, durationMs: Number(cachedReattachmentDurationMs.toFixed(2)), millisecondsPerBar: cachedRendererBarCount === 0 ? 0 : Number((cachedReattachmentDurationMs / cachedRendererBarCount).toFixed(2)) },
                { phase: 'changed range layout', barCount: changedRangeBarCount, durationMs: Number(changedRangeLayoutDurationMs.toFixed(2)), millisecondsPerBar: changedRangeBarCount === 0 ? 0 : Number((changedRangeLayoutDurationMs / changedRangeBarCount).toFixed(2)) },
                { phase: 'assembly bookkeeping', durationMs: Number((assemblyCompletedAt - performanceStartedAt - cachedReattachmentDurationMs - changedRangeLayoutDurationMs).toFixed(2)) },
                { phase: 'renderer alignment', durationMs: Number((alignmentCompletedAt - assemblyCompletedAt).toFixed(2)) },
                { phase: 'system finalization', durationMs: Number((finalizationCompletedAt - alignmentCompletedAt).toFixed(2)) },
                { phase: 'bounds construction', durationMs: Number((boundsCompletedAt - boundsStartedAt).toFixed(2)) },
                { phase: 'partial registration and footer', durationMs: Number((completedAt - boundsCompletedAt).toFixed(2)) },
                { phase: 'horizontal total', durationMs: Number((completedAt - performanceStartedAt).toFixed(2)) }
            ]);
            console.groupEnd();
        }
    }

    private _scaleBars(result: MasterBarsRenderers) {
        result.width = 0;
        this._system!.width -= result.width;
        for (const r of result.renderers) {
            const barDisplayWidth =
                r.staff!.system.staves.length > 1 ? r.bar.masterBar.displayWidth : r.bar.displayWidth;
            // Fall back to natural width so `scaleToWidth` still runs.
            r.scaleToWidth(barDisplayWidth > 0 ? barDisplayWidth : r.width);
            const w = r.x + r.width;
            if (w > result.width) {
                result.width = w;
            }
        }
        this._system!.width += result.width;
    }

    private _completePartial(
        partials: HorizontalScreenLayoutPartialInfo[],
        currentPartial: HorizontalScreenLayoutPartialInfo
    ) {
        if (partials.length === 0) {
            // respect accolade and on first partial
            currentPartial.width += this._system!.accoladeWidth + this.pagePadding![0];
        }

        partials.push(currentPartial);
        Logger.debug(
            this.name,
            `Finished partial from bar ${currentPartial.masterBars[0].index} to ${currentPartial.masterBars[currentPartial.masterBars.length - 1].index}`,
            null
        );

        // start new partial
        const newPartial = new HorizontalScreenLayoutPartialInfo();
        newPartial.x = currentPartial.x + currentPartial.width;
        return newPartial;
    }

    private _alignRenderers(): void {
        this.width = 0;
        const system = this._system!;
        // `_scaleBars` already ran. supportsResize=false ⇒ fresh
        // StaffSystem per render, so no shared-layout-data reset is needed.
        for (const s of system.allStaves) {
            let w = 0;
            for (const renderer of s.barRenderers) {
                renderer.x = w;
                w += renderer.width;
            }

            if (w > this.width) {
                system.width = w;
            }
        }
        system.width += system.accoladeWidth;
    }
}
