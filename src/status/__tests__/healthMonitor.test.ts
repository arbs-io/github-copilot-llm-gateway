import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateHealthBackoff,
  HealthMonitor,
  HealthMonitorTimerHooks,
} from '../healthMonitor';

interface ScheduledTimer {
  id: number;
  callback: () => void;
  delayMs: number;
}

class FakeTimers implements HealthMonitorTimerHooks {
  private nextId = 1;
  public readonly scheduled: ScheduledTimer[] = [];

  public setTimeout(callback: () => void, delayMs: number): number {
    const timer = { id: this.nextId++, callback, delayMs };
    this.scheduled.push(timer);
    return timer.id;
  }

  public clearTimeout(handle: unknown): void {
    const index = this.scheduled.findIndex((timer) => timer.id === handle);
    if (index >= 0) { this.scheduled.splice(index, 1); }
  }

  public fireNext(): number {
    const timer = this.scheduled.shift();
    assert.ok(timer, 'expected a scheduled timer');
    timer.callback();
    return timer.delayMs;
  }
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('calculateHealthBackoff', () => {
  test('doubles from 30 seconds and caps at five minutes', () => {
    assert.deepEqual(
      [1, 2, 3, 4, 5, 20].map((failures) => calculateHealthBackoff(failures)),
      [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]
    );
  });
});

describe('HealthMonitor', () => {
  test('preserves the initial delay and fixed healthy interval', async () => {
    const timers = new FakeTimers();
    let probes = 0;
    const monitor = new HealthMonitor({
      timers,
      probe: async () => { probes++; return true; },
    });

    assert.equal(timers.fireNext(), 1_500);
    await settle();
    assert.equal(probes, 1);
    assert.equal(timers.scheduled[0]?.delayMs, 60_000);
    monitor.dispose();
  });

  test('backs off failures and resets the count after success', async () => {
    const timers = new FakeTimers();
    const results = [false, false, true, false];
    const monitor = new HealthMonitor({
      timers,
      initialDelayMs: 0,
      probe: async () => results.shift() ?? true,
    });

    assert.equal(timers.fireNext(), 0);
    await settle();
    assert.equal(timers.fireNext(), 30_000);
    await settle();
    assert.equal(timers.fireNext(), 60_000);
    await settle();
    assert.equal(timers.fireNext(), 60_000);
    await settle();
    assert.equal(timers.scheduled[0]?.delayMs, 30_000);
    monitor.dispose();
  });

  test('never overlaps probes and schedules only after settlement', async () => {
    const timers = new FakeTimers();
    let resolveProbe: ((value: boolean) => void) | undefined;
    let active = 0;
    let maximumActive = 0;
    const monitor = new HealthMonitor({
      timers,
      initialDelayMs: 0,
      probe: () => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        return new Promise<boolean>((resolve) => {
          resolveProbe = (value) => {
            active--;
            resolve(value);
          };
        });
      },
    });

    timers.fireNext();
    assert.equal(timers.scheduled.length, 0);
    assert.equal(maximumActive, 1);
    resolveProbe?.(true);
    await settle();
    assert.equal(timers.scheduled[0]?.delayMs, 60_000);
    assert.equal(maximumActive, 1);
    monitor.dispose();
  });

  test('contains rejected probes and treats them as failures', async () => {
    const timers = new FakeTimers();
    const monitor = new HealthMonitor({
      timers,
      initialDelayMs: 0,
      probe: async () => { throw new Error('offline'); },
    });

    timers.fireNext();
    await settle();
    assert.equal(timers.scheduled[0]?.delayMs, 30_000);
    monitor.dispose();
  });

  test('clears pending work and aborts an active probe on dispose', async () => {
    const pendingTimers = new FakeTimers();
    const pending = new HealthMonitor({ timers: pendingTimers, probe: async () => true });
    pending.dispose();
    assert.equal(pendingTimers.scheduled.length, 0);

    const activeTimers = new FakeTimers();
    let observedSignal: AbortSignal | undefined;
    let resolveProbe: (() => void) | undefined;
    const active = new HealthMonitor({
      timers: activeTimers,
      initialDelayMs: 0,
      probe: (signal) => new Promise<void>((resolve) => {
        observedSignal = signal;
        resolveProbe = resolve;
      }),
    });
    activeTimers.fireNext();
    active.dispose();
    assert.equal(observedSignal?.aborted, true);
    resolveProbe?.();
    await settle();
    assert.equal(activeTimers.scheduled.length, 0);
  });
});
