import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import {
  currentOperationDeadlineSignal,
  execOperationChildProcess,
  OperationCancelledError,
  OperationChildProcessTimeoutError,
  OperationDeadlineExceededError,
  withOperationDeadline
} from "../../src/core/operation-deadline.js";

describe("operation deadline", () => {
  it("normalizes external abort reasons into a stable cancellation error", async () => {
    const controller = new AbortController();
    controller.abort(new Error("SDK transport closed"));

    await expect(withOperationDeadline(1_000, async () => undefined, controller.signal)).rejects.toBeInstanceOf(
      OperationCancelledError
    );
  });

  it("requests cancellation but awaits started work before rejecting", async () => {
    let observedAbort = false;
    let workFinished = false;
    const startedAt = Date.now();

    await expect(
      withOperationDeadline(20, async () => {
        const signal = currentOperationDeadlineSignal();
        signal?.addEventListener("abort", () => {
          observedAbort = true;
        });
        // Deliberately ignore the signal. The deadline wrapper must not reject
        // through a naked race while this started work remains in flight.
        await delay(60);
        workFinished = true;
      })
    ).rejects.toBeInstanceOf(OperationDeadlineExceededError);

    expect(observedAbort).toBe(true);
    expect(workFinished).toBe(true);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(50);
  });

  it("preserves a committed result when the deadline is observed after the write", async () => {
    await expect(
      withOperationDeadline(20, async () => {
        await delay(40);
        return { committed: true, event_id: "evt_committed" };
      })
    ).rejects.toMatchObject({
      code: "OPERATION_DEADLINE_EXCEEDED",
      committed: true,
      recovery_hint: {
        deadline_observed_after_commit: true,
        committed_result: { committed: true, event_id: "evt_committed" }
      }
    });
  });

  it("does not replace a partial-commit error after cancellation", async () => {
    const partial = Object.assign(new Error("mutation partially committed"), {
      code: "MUTATION_PARTIALLY_COMMITTED",
      committed: true,
      recovery_hint: { committed_event_ids: ["evt_partial"] }
    });

    await expect(
      withOperationDeadline(20, async () => {
        await delay(40);
        throw partial;
      })
    ).rejects.toBe(partial);
  });

  it("keeps a local child timeout distinct from an inherited operation deadline", async () => {
    await expect(
      execOperationChildProcess(process.execPath, ["--eval", "setInterval(() => undefined, 1000)"], {
        cwd: process.cwd(),
        timeoutMs: 20
      })
    ).rejects.toBeInstanceOf(OperationChildProcessTimeoutError);
  });

  it("escalates an ignored TERM to KILL and waits for child close", async () => {
    const startedAt = Date.now();
    const script = "process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000)";

    await expect(
      withOperationDeadline(100, () =>
        execOperationChildProcess(process.execPath, ["--eval", script], { cwd: process.cwd() })
      )
    ).rejects.toBeInstanceOf(OperationDeadlineExceededError);

    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(2_000);
  });

  it("kills a TERM-ignoring descendant after its direct parent closes and releases stdio", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-operation-child-"));
    const descendantPidPath = join(root, "descendant.pid");
    try {
      const startedAt = Date.now();
      const descendantScript = "process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000)";
      const parentScript = [
        "const { spawn } = require('node:child_process');",
        "const { writeFileSync } = require('node:fs');",
        `const child = spawn(process.execPath, ['--eval', ${JSON.stringify(descendantScript)}], { stdio: 'ignore' });`,
        `writeFileSync(${JSON.stringify(descendantPidPath)}, String(child.pid));`,
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => undefined, 1000);"
      ].join(" ");
      await expect(
        withOperationDeadline(300, () =>
          execOperationChildProcess(process.execPath, ["--eval", parentScript], { cwd: process.cwd() })
        )
      ).rejects.toBeInstanceOf(OperationDeadlineExceededError);

      const elapsed = Date.now() - startedAt;
      expect(elapsed).toBeGreaterThanOrEqual(500);
      expect(elapsed).toBeLessThan(2_000);
      const descendantPid = Number(await readFile(descendantPidPath, "utf8"));
      expect(() => process.kill(descendantPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
