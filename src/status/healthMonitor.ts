export const HEALTH_MONITOR_DEFAULTS = Object.freeze({
  initialDelayMs: 1_500,
  healthyIntervalMs: 60_000,
  failureBaseDelayMs: 30_000,
  failureMaxDelayMs: 300_000,
});

export interface HealthMonitorTimerHooks {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface HealthMonitorOptions {
  /**
   * Return `false` for an unhealthy probe. `true` or `void` is healthy.
   * Thrown/rejected errors are contained and treated as failures.
   */
  probe: (signal: AbortSignal) => Promise<boolean | void>;
  initialDelayMs?: number;
  healthyIntervalMs?: number;
  failureBaseDelayMs?: number;
  failureMaxDelayMs?: number;
  timers?: HealthMonitorTimerHooks;
}

const SYSTEM_TIMERS: HealthMonitorTimerHooks = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Compute the delay after a consecutive probe failure. The first failure uses
 * `baseDelayMs`; later failures double until `maxDelayMs`.
 */
export function calculateHealthBackoff(
  consecutiveFailures: number,
  baseDelayMs: number = HEALTH_MONITOR_DEFAULTS.failureBaseDelayMs,
  maxDelayMs: number = HEALTH_MONITOR_DEFAULTS.failureMaxDelayMs
): number {
  const base = normalizeDelay(baseDelayMs, HEALTH_MONITOR_DEFAULTS.failureBaseDelayMs);
  const maximum = Math.max(base, normalizeDelay(maxDelayMs, HEALTH_MONITOR_DEFAULTS.failureMaxDelayMs));
  const failures = Math.max(1, Math.floor(consecutiveFailures));
  const exponent = Math.min(30, failures - 1);
  return Math.min(maximum, base * (2 ** exponent));
}

/**
 * Disposable, single-flight health scheduler. It schedules the next probe
 * only after the current one settles, so slow requests can never overlap.
 */
export class HealthMonitor {
  private readonly probe: HealthMonitorOptions['probe'];
  private readonly timers: HealthMonitorTimerHooks;
  private readonly healthyIntervalMs: number;
  private readonly failureBaseDelayMs: number;
  private readonly failureMaxDelayMs: number;
  private timer: unknown;
  private activeProbe?: AbortController;
  private consecutiveFailures = 0;
  private disposed = false;

  constructor(options: HealthMonitorOptions) {
    this.probe = options.probe;
    this.timers = options.timers ?? SYSTEM_TIMERS;
    this.healthyIntervalMs = normalizeDelay(
      options.healthyIntervalMs,
      HEALTH_MONITOR_DEFAULTS.healthyIntervalMs
    );
    this.failureBaseDelayMs = normalizeDelay(
      options.failureBaseDelayMs,
      HEALTH_MONITOR_DEFAULTS.failureBaseDelayMs
    );
    this.failureMaxDelayMs = Math.max(
      this.failureBaseDelayMs,
      normalizeDelay(options.failureMaxDelayMs, HEALTH_MONITOR_DEFAULTS.failureMaxDelayMs)
    );
    this.schedule(
      normalizeDelay(options.initialDelayMs, HEALTH_MONITOR_DEFAULTS.initialDelayMs, true)
    );
  }

  public dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.activeProbe?.abort();
    this.activeProbe = undefined;
  }

  private schedule(delayMs: number): void {
    if (this.disposed) { return; }
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      void this.runProbe();
    }, delayMs);
  }

  private async runProbe(): Promise<void> {
    // `schedule` is single-flight, but retain this guard for timer-hook bugs or
    // re-entrant callbacks in tests.
    if (this.disposed || this.activeProbe) { return; }

    const controller = new AbortController();
    this.activeProbe = controller;
    let succeeded = false;
    try {
      succeeded = (await this.probe(controller.signal)) !== false;
    } catch {
      // Silent monitoring must never leak a rejected promise. The existing
      // status refresh owns user-visible error rendering.
      succeeded = false;
    } finally {
      if (this.activeProbe === controller) {
        this.activeProbe = undefined;
      }
    }

    if (this.disposed) { return; }
    if (succeeded) {
      this.consecutiveFailures = 0;
      this.schedule(this.healthyIntervalMs);
      return;
    }

    this.consecutiveFailures++;
    this.schedule(
      calculateHealthBackoff(
        this.consecutiveFailures,
        this.failureBaseDelayMs,
        this.failureMaxDelayMs
      )
    );
  }
}

function normalizeDelay(value: number | undefined, fallback: number, allowZero = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) { return fallback; }
  const minimum = allowZero ? 0 : 1;
  return Math.max(minimum, Math.floor(value));
}
