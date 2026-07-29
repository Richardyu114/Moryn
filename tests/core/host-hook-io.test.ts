import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostHookInputLimitError, readHostHookInput } from "../../src/core/host-hook-io.js";
import {
  HOST_HOOK_OPERATION_BUDGET_MS,
  HOST_HOOK_PROCESS_WATCHDOG_MS,
  HOST_HOOK_TIMEOUT_SECONDS,
  startHostHookProcessWatchdog
} from "../../src/core/host-hook-timing.js";
import {
  currentOperationDeadlineSignal,
  OperationDeadlineExceededError,
  withOperationDeadline
} from "../../src/core/operation-deadline.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("host hook input and timing", () => {
  it("reads a completed payload within its byte limit", async () => {
    const input = new PassThrough();
    input.end('{"hook_event_name":"Stop"}');
    await expect(readHostHookInput(input, undefined, 1024)).resolves.toBe('{"hook_event_name":"Stop"}');
  });

  it("rejects and closes input that exceeds its byte limit", async () => {
    const input = new PassThrough();
    const read = readHostHookInput(input, undefined, 4);
    input.end("12345");
    await expect(read).rejects.toBeInstanceOf(HostHookInputLimitError);
    expect(input.destroyed).toBe(true);
  });

  it("cancels stdin that remains open when the operation deadline expires", async () => {
    const input = new PassThrough();
    input.write("{");
    await expect(
      withOperationDeadline(25, () => readHostHookInput(input, currentOperationDeadlineSignal(), 1024))
    ).rejects.toBeInstanceOf(OperationDeadlineExceededError);
    expect(input.destroyed).toBe(true);
  });

  it("keeps cleanup and watchdog budgets inside the host timeout", () => {
    expect(HOST_HOOK_OPERATION_BUDGET_MS).toBeLessThan(HOST_HOOK_PROCESS_WATCHDOG_MS);
    expect(HOST_HOOK_PROCESS_WATCHDOG_MS).toBeLessThan(HOST_HOOK_TIMEOUT_SECONDS * 1000);
  });

  it("arms and cancels the final process watchdog", async () => {
    vi.useFakeTimers();
    const timedOut = vi.fn();
    startHostHookProcessWatchdog(timedOut, 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(timedOut).toHaveBeenCalledOnce();

    const cancelled = vi.fn();
    const cancel = startHostHookProcessWatchdog(cancelled, 100);
    cancel();
    await vi.advanceTimersByTimeAsync(100);
    expect(cancelled).not.toHaveBeenCalled();
  });
});
