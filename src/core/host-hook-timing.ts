/**
 * Host-owned command hooks have a 30 second outer timeout. Moryn stops remote
 * and lock-bound work earlier, then keeps a small cleanup window before the
 * process watchdog exits successfully to avoid surfacing a host Hook failure.
 */
export const HOST_HOOK_TIMEOUT_SECONDS = 30;
export const HOST_HOOK_OPERATION_BUDGET_MS = 20_000;
export const HOST_HOOK_PROCESS_WATCHDOG_MS = 25_000;

/** Bounds stdin retained before official hook payloads are parsed. */
export const HOST_HOOK_INPUT_LIMIT_BYTES = 1024 * 1024;

export function startHostHookProcessWatchdog(
  onTimeout: () => void,
  timeoutMs = HOST_HOOK_PROCESS_WATCHDOG_MS
): () => void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Invalid argument: host hook watchdog timeout must be a positive finite number");
  }
  const timer = setTimeout(onTimeout, timeoutMs);
  timer.unref();
  return () => clearTimeout(timer);
}
