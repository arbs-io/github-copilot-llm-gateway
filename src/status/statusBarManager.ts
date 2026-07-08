import * as vscode from 'vscode';
import { RequestStateEvent } from '../provider/gatewayProvider';
import { StatusBarState, renderStatusBar } from './statusBarRenderer';
import { TokenUsage } from './sessionStats';
import { extractHost } from './format';
import { StatusSnapshot } from './statusSnapshot';
import { renderStatusTooltipHtml } from './statusTooltip';

/** How long the "responded" pulse stays in the bar before reverting to idle. */
const RESPONDED_DISPLAY_MS = 10_000;

/**
 * Drives the LLM Gateway status bar. Pure rendering lives in
 * `statusBarRenderer.ts`; this class only handles the VS Code-side state
 * machine: timers, in-flight counting, mapping events onto state transitions.
 */
export class StatusBarManager implements vscode.Disposable {
  private state: StatusBarState;
  private respondedRevertTimer?: NodeJS.Timeout;
  private activeRequestCount = 0;
  private cachedIdle: { host: string; modelIds: readonly string[] } = {
    host: '',
    modelIds: [],
  };

  constructor(
    private readonly item: vscode.StatusBarItem,
    private readonly getServerUrl: () => string,
    private readonly getSnapshot: () => StatusSnapshot
  ) {
    this.state = { kind: 'probing', host: extractHost(this.getServerUrl()) };
    this.render();
  }

  /**
   * Called from outside whenever the provider's snapshot changes (session
   * totals, last request, models, connection state). The tooltip is rebuilt
   * from the snapshot, so any new data shows up the next time the user hovers
   * the status bar — even if the bar's icon state hasn't changed.
   */
  refreshTooltip(): void {
    this.render();
  }

  dispose(): void {
    this.cancelRespondedRevert();
  }

  setIdle(modelIds: readonly string[]): void {
    this.cachedIdle = { host: this.host(), modelIds };
    this.cancelRespondedRevert();
    this.applyIdle();
  }

  setNoModels(): void {
    this.cancelRespondedRevert();
    this.state = { kind: 'noModels', host: this.host() };
    this.render();
  }

  setError(errorMessage: string): void {
    this.cancelRespondedRevert();
    this.state = { kind: 'error', host: this.host(), errorMessage };
    this.render();
  }

  onRequest(event: RequestStateEvent): void {
    switch (event.kind) {
      case 'start':
        this.onRequestStart(event);
        return;
      case 'complete':
        this.onRequestComplete(event);
        return;
      case 'error':
        this.onRequestError(event);
        return;
      default: {
        const _never: never = event;
        throw new Error(`Unexpected request state kind: ${String(_never)}`);
      }
    }
  }

  private onRequestStart(event: Extract<RequestStateEvent, { kind: 'start' }>): void {
    this.cancelRespondedRevert();
    this.activeRequestCount++;
    this.state = {
      kind: 'streaming',
      host: this.host(),
      modelId: event.modelId,
      modelName: event.modelName,
      activeCount: this.activeRequestCount,
    };
    this.render();
  }

  private onRequestComplete(
    event: Extract<RequestStateEvent, { kind: 'complete' }>
  ): void {
    this.activeRequestCount = Math.max(0, this.activeRequestCount - 1);
    if (this.activeRequestCount > 0) {
      // Other requests still streaming — keep the bar in streaming state with
      // an updated count rather than briefly flashing "responded".
      this.state = {
        kind: 'streaming',
        host: this.host(),
        modelId: event.modelId,
        modelName: event.modelName,
        activeCount: this.activeRequestCount,
      };
      this.render();
      return;
    }
    this.state = {
      kind: 'responded',
      host: this.host(),
      modelId: event.modelId,
      modelName: event.modelName,
      ...(event.usage ? { usage: this.toUsage(event.usage) } : {}),
    };
    this.render();
    this.scheduleRespondedRevert();
  }

  private onRequestError(event: Extract<RequestStateEvent, { kind: 'error' }>): void {
    this.activeRequestCount = Math.max(0, this.activeRequestCount - 1);
    this.setError(event.errorMessage);
  }

  private toUsage(usage: TokenUsage): TokenUsage {
    return { prompt: usage.prompt, completion: usage.completion, total: usage.total };
  }

  private applyIdle(): void {
    this.state = {
      kind: 'idle',
      host: this.cachedIdle.host,
      modelCount: this.cachedIdle.modelIds.length,
      modelIds: this.cachedIdle.modelIds,
    };
    this.render();
  }

  private scheduleRespondedRevert(): void {
    this.cancelRespondedRevert();
    this.respondedRevertTimer = setTimeout(() => {
      this.respondedRevertTimer = undefined;
      this.applyIdle();
    }, RESPONDED_DISPLAY_MS);
  }

  private cancelRespondedRevert(): void {
    if (this.respondedRevertTimer) {
      clearTimeout(this.respondedRevertTimer);
      this.respondedRevertTimer = undefined;
    }
  }

  private host(): string {
    return extractHost(this.getServerUrl());
  }

  private render(): void {
    // Bar text stays minimal (vm-active/vm-disconnect + host) — that's the
    // "is the gateway up" signal. All the rich data goes into the hover
    // tooltip, which is the closest stable-API approximation to GHCP's
    // floating popup (`chatStatusItem` is proposed-API-only).
    const { text } = renderStatusBar(this.state);
    this.item.text = text;
    // Tooltip renders as the GHCP-style popup: HTML card with theme icons,
    // section headers, and command-link buttons. MarkdownString runs the value
    // through VS Code's hover renderer, which is the closest stable-API path
    // to a click-triggered floating popup (`chatStatusItem` is proposed-only).
    const tooltipHtml = renderStatusTooltipHtml(this.getSnapshot());
    const md = new vscode.MarkdownString(tooltipHtml);
    md.isTrusted = true;
    md.supportThemeIcons = true;
    md.supportHtml = true;
    this.item.tooltip = md;
  }
}
