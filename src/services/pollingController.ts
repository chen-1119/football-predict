export interface PollingClock {
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}
export interface PollingOptions<T> {
  request: (signal: AbortSignal) => Promise<T>;
  onData: (data: T) => void;
  onError: (error: unknown) => void;
  onSettled?: () => void;
  isVisible?: () => boolean;
  intervalMs?: number;
  timeoutMs?: number;
  maxRetryMs?: number;
  clock?: PollingClock;
}
export function createPollingController<T>(options: PollingOptions<T>) {
  const clock = options.clock ?? { setTimeout, clearTimeout };
  const intervalMs = options.intervalMs ?? 30_000;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxRetryMs = options.maxRetryMs ?? 120_000;
  if (![intervalMs, timeoutMs, maxRetryMs].every((x) => Number.isFinite(x) && x > 0)) throw new RangeError('Invalid polling timing');
  let stopped = false, started = false, failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let active: AbortController | undefined;
  const clearScheduled = () => { if (timer !== undefined) { clock.clearTimeout(timer); timer = undefined; } };
  const visible = () => options.isVisible?.() !== false;
  function schedule(delay: number) {
    clearScheduled();
    if (!stopped && visible()) timer = clock.setTimeout(() => { timer = undefined; void load(); }, delay);
  }
  async function load() {
    if (stopped || active || !visible()) return;
    clearScheduled();
    const controller = new AbortController(); active = controller;
    timeout = clock.setTimeout(() => controller.abort(), timeoutMs);
    let terminal = false;
    try {
      const value = await options.request(controller.signal);
      if (!stopped && active === controller && !controller.signal.aborted) {
        options.onData(value); failures = 0;
      } else if (!stopped && controller.signal.aborted) {
        throw new Error('Polling response exceeded its request deadline');
      }
    } catch (error: unknown) {
      if (!stopped && active === controller) {
        failures += 1;
        terminal = typeof error === 'object' && error !== null && 'status' in error
          && (error.status === 401 || error.status === 403);
        options.onError(error);
      }
    } finally {
      if (timeout !== undefined) { clock.clearTimeout(timeout); timeout = undefined; }
      if (active === controller) active = undefined;
      if (!stopped) {
        options.onSettled?.();
        if (!terminal) schedule(failures ? Math.min(maxRetryMs, intervalMs * 2 ** Math.min(failures - 1, 10)) : intervalMs);
      }
    }
  }
  return {
    start() { if (!started && !stopped) { started = true; void load(); } },
    refresh() { if (!stopped) { started = true; clearScheduled(); void load(); } },
    visibilityChanged() { if (!visible()) clearScheduled(); else this.refresh(); },
    stop() {
      stopped = true; clearScheduled();
      if (timeout !== undefined) { clock.clearTimeout(timeout); timeout = undefined; }
      active?.abort();
    },
  };
}
