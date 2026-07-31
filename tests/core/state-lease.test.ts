import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { OperationDeadlineExceededError, withOperationDeadline } from "../../src/core/operation-deadline.js";
import { withStoreStateLease } from "../../src/core/state-lease.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

const CHILD_LEASE_SCRIPT = `
const { withStoreStateLease } = await import(process.env.MORYN_TEST_LEASE_MODULE);
await withStoreStateLease(process.env.MORYN_TEST_STORE_PATH, async () => {
  process.stdout.write("lease-acquired\\n");
  await new Promise(() => setInterval(() => undefined, 1000));
});
`;

function waitForChildLease(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for child state lease")), 5_000);
    timeout.unref();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (!output.includes("lease-acquired\n")) return;
      clearTimeout(timeout);
      resolve();
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Child exited before acquiring state lease: ${code ?? signal}`));
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function killChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await once(child, "exit");
}

describe("store state lease", () => {
  it("honors a tighter inherited operation deadline while another owner is live", async () => {
    await withInitializedTempStore(async (storePath) => {
      let releaseOwner!: () => void;
      const ownerGate = new Promise<void>((resolve) => {
        releaseOwner = resolve;
      });
      let ownerStarted!: () => void;
      const ownerStartedPromise = new Promise<void>((resolve) => {
        ownerStarted = resolve;
      });
      const owner = withStoreStateLease(storePath, async () => {
        ownerStarted();
        await ownerGate;
      });
      await ownerStartedPromise;
      let competitorEntered = false;

      try {
        const startedAt = Date.now();
        await expect(
          withOperationDeadline(100, () =>
            withStoreStateLease(storePath, async () => {
              competitorEntered = true;
              return "must not enter";
            })
          )
        ).rejects.toBeInstanceOf(OperationDeadlineExceededError);
        expect(Date.now() - startedAt).toBeLessThan(2_000);
        expect(competitorEntered).toBe(false);
      } finally {
        releaseOwner();
        await owner;
      }
      await expect(withStoreStateLease(storePath, async () => "recovered")).resolves.toBe("recovered");
    });
  });

  it("finishes expired-operation cleanup before exposing the deadline", async () => {
    await withInitializedTempStore(async (storePath) => {
      const leasePath = join(storePath, "state", "store-state.lease");
      let workFinished = false;

      await expect(
        withOperationDeadline(20, () =>
          withStoreStateLease(storePath, async () => {
            await delay(60);
            workFinished = true;
          })
        )
      ).rejects.toBeInstanceOf(OperationDeadlineExceededError);

      expect(workFinished).toBe(true);
      await expect(stat(leasePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(withStoreStateLease(storePath, async () => "next owner")).resolves.toBe("next owner");
    });
  });

  it("releases its lease when a live recovery gate exceeds the cleanup budget", async () => {
    await withInitializedTempStore(async (storePath) => {
      const statePath = join(storePath, "state");
      const leasePath = join(statePath, "store-state.lease");
      const recoveryPath = join(statePath, "store-state.recovery");

      await withStoreStateLease(storePath, async () => {
        await mkdir(recoveryPath, { mode: 0o700 });
        await writeFile(
          join(recoveryPath, "owner.json"),
          `${JSON.stringify({ version: 1, token: "live-test-gate", pid: process.pid })}\n`,
          { mode: 0o600 }
        );
      });

      await expect(stat(leasePath)).rejects.toMatchObject({ code: "ENOENT" });
      await rm(recoveryPath, { recursive: true, force: true });
      await expect(withStoreStateLease(storePath, async () => "reacquired")).resolves.toBe("reacquired");
    });
  });

  it("releases the lease after exceptional work and permits the next owner", async () => {
    await withInitializedTempStore(async (storePath) => {
      const leasePath = join(storePath, "state", "store-state.lease");
      await chmod(join(storePath, "state"), 0o777);
      await expect(
        withStoreStateLease(storePath, async () => {
          throw new Error("injected lease work failure");
        })
      ).rejects.toThrow("injected lease work failure");
      await expect(stat(leasePath)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await stat(join(storePath, "state"))).mode & 0o777).toBe(0o700);

      await expect(
        withStoreStateLease(storePath, async () => withStoreStateLease(storePath, async () => "nested lease completed"))
      ).resolves.toBe("nested lease completed");
      await expect(stat(leasePath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("preserves the work error when lease cleanup also fails", async () => {
    await withInitializedTempStore(async (storePath) => {
      const statePath = join(storePath, "state");
      const leasePath = join(statePath, "store-state.lease");
      const ownerPath = join(leasePath, "owner.json");
      const recoveryPath = join(statePath, "store-state.recovery");
      const workError = new Error("injected work failure before cleanup");

      let caught: unknown;
      try {
        await withStoreStateLease(storePath, async () => {
          const owner = JSON.parse(await readFile(ownerPath, "utf8")) as { token: string };
          const conflictingReleasedPath = `${leasePath}.released-${owner.token}`;
          await mkdir(conflictingReleasedPath);
          await writeFile(join(conflictingReleasedPath, "blocker"), "keep destination non-empty\n", "utf8");
          // A non-directory recovery path makes the normal gate cleanup fail;
          // the pre-created non-empty release target then makes the atomic
          // fallback fail as well.
          await writeFile(recoveryPath, "injected recovery gate failure\n", "utf8");
          throw workError;
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AggregateError);
      const aggregate = caught as AggregateError;
      expect(aggregate.message).toBe("Store state lease work and cleanup both failed");
      expect(aggregate.cause).toBe(workError);
      expect(aggregate.errors).toHaveLength(2);
      expect(aggregate.errors[0]).toBe(workError);
      expect(aggregate.errors[1]).toBeInstanceOf(Error);
    });
  });

  it("drains already-started reentrant work before releasing to a competing owner", async () => {
    await withInitializedTempStore(async (storePath) => {
      const order: string[] = [];
      let releaseNested!: () => void;
      const nestedGate = new Promise<void>((resolve) => {
        releaseNested = resolve;
      });
      let nestedStarted!: () => void;
      const nestedStartedPromise = new Promise<void>((resolve) => {
        nestedStarted = resolve;
      });
      let outerReturning!: () => void;
      const outerReturningPromise = new Promise<void>((resolve) => {
        outerReturning = resolve;
      });
      let nestedWork: Promise<void> | undefined;

      const outer = withStoreStateLease(storePath, async () => {
        nestedWork = withStoreStateLease(storePath, async () => {
          order.push("nested-start");
          nestedStarted();
          await nestedGate;
          order.push("nested-end");
        });
        await nestedStartedPromise;
        order.push("outer-return");
        outerReturning();
      });

      await outerReturningPromise;
      const competitor = withStoreStateLease(storePath, async () => {
        order.push("competitor");
      });
      await delay(20);
      expect(order).toEqual(["nested-start", "outer-return"]);

      releaseNested();
      await Promise.all([outer, nestedWork, competitor]);
      expect(order).toEqual(["nested-start", "outer-return", "nested-end", "competitor"]);
    });
  });

  it("keeps the lease reentrant while already-started nested work is draining", async () => {
    await withInitializedTempStore(async (storePath) => {
      const order: string[] = [];
      let continueNested!: () => void;
      const nestedGate = new Promise<void>((resolve) => {
        continueNested = resolve;
      });
      let nestedStarted!: () => void;
      const nestedStartedPromise = new Promise<void>((resolve) => {
        nestedStarted = resolve;
      });
      let outerReturning!: () => void;
      const outerReturningPromise = new Promise<void>((resolve) => {
        outerReturning = resolve;
      });
      let nestedWork: Promise<void> | undefined;

      const outer = withStoreStateLease(storePath, async () => {
        nestedWork = withStoreStateLease(storePath, async () => {
          order.push("nested-start");
          nestedStarted();
          await nestedGate;
          await withStoreStateLease(storePath, async () => {
            order.push("nested-reentrant");
          });
          order.push("nested-end");
        });
        await nestedStartedPromise;
        order.push("outer-return");
        outerReturning();
      });

      await outerReturningPromise;
      const competitor = withStoreStateLease(storePath, async () => {
        order.push("competitor");
      });
      await delay(20);
      expect(order).toEqual(["nested-start", "outer-return"]);

      continueNested();
      await Promise.all([outer, nestedWork, competitor]);
      expect(order).toEqual(["nested-start", "outer-return", "nested-reentrant", "nested-end", "competitor"]);
    });
  });

  it("does not take over a live owner solely because its heartbeat timestamp looks stale", async () => {
    await withInitializedTempStore(async (storePath) => {
      const ownerPath = join(storePath, "state", "store-state.lease", "owner.json");
      let releaseOwner!: () => void;
      const ownerGate = new Promise<void>((resolve) => {
        releaseOwner = resolve;
      });
      let ownerStarted!: () => void;
      const ownerStartedPromise = new Promise<void>((resolve) => {
        ownerStarted = resolve;
      });
      let competitorEntered = false;

      const owner = withStoreStateLease(storePath, async () => {
        ownerStarted();
        await ownerGate;
      });
      await ownerStartedPromise;
      const staleAt = new Date("2000-01-01T00:00:00.000Z");
      await utimes(ownerPath, staleAt, staleAt);

      const competitor = withStoreStateLease(storePath, async () => {
        competitorEntered = true;
      });
      await delay(75);
      expect(competitorEntered).toBe(false);

      releaseOwner();
      await Promise.all([owner, competitor]);
      expect(competitorEntered).toBe(true);
    });
  });

  it("does not take over a fresh heartbeat solely because the owner pid appears dead", async () => {
    await withInitializedTempStore(async (storePath) => {
      const leasePath = join(storePath, "state", "store-state.lease");
      const ownerPath = join(leasePath, "owner.json");
      await mkdir(leasePath, { recursive: true, mode: 0o700 });
      await writeFile(ownerPath, `${JSON.stringify({ version: 1, token: "pid-namespace-owner", pid: 4_000_000 })}\n`, {
        encoding: "utf8",
        mode: 0o600
      });
      let competitorEntered = false;
      const competitor = withStoreStateLease(storePath, async () => {
        competitorEntered = true;
      });

      await delay(75);
      expect(competitorEntered).toBe(false);

      const staleAt = new Date("2000-01-01T00:00:00.000Z");
      await utimes(ownerPath, staleAt, staleAt);
      await competitor;
      expect(competitorEntered).toBe(true);
    });
  });

  it.each(["lease", "recovery gate"] as const)(
    "recovers a stale %s despite a colliding live pid from another namespace",
    async (kind) => {
      await withInitializedTempStore(async (storePath) => {
        const statePath = join(storePath, "state");
        const ownerDirectory = join(statePath, kind === "lease" ? "store-state.lease" : "store-state.recovery");
        await mkdir(ownerDirectory, { recursive: true, mode: 0o700 });
        const ownerPath = join(ownerDirectory, "owner.json");
        await writeFile(
          ownerPath,
          `${JSON.stringify({
            version: 1,
            token: "other-namespace-owner",
            pid: process.pid,
            process_instance_id: "foreign-process-instance",
            process_start_identity: "foreign-boot:pid:[999999]:1"
          })}\n`,
          { encoding: "utf8", mode: 0o600 }
        );
        const staleAt = new Date("2000-01-01T00:00:00.000Z");
        await utimes(ownerPath, staleAt, staleAt);

        await expect(
          withOperationDeadline(500, () => withStoreStateLease(storePath, async () => "recovered"))
        ).resolves.toBe("recovered");
        await expect(stat(ownerDirectory)).rejects.toMatchObject({ code: "ENOENT" });
      });
    }
  );

  it("does not steal an identity-less legacy lease from an ambiguous live pid", async () => {
    await withInitializedTempStore(async (storePath) => {
      const leasePath = join(storePath, "state", "store-state.lease");
      const ownerPath = join(leasePath, "owner.json");
      await mkdir(leasePath, { recursive: true, mode: 0o700 });
      await writeFile(ownerPath, `${JSON.stringify({ version: 1, token: "legacy-live-owner", pid: process.pid })}\n`, {
        encoding: "utf8",
        mode: 0o600
      });
      const staleAt = new Date("2000-01-01T00:00:00.000Z");
      await utimes(ownerPath, staleAt, staleAt);
      let competitorEntered = false;

      await expect(
        withOperationDeadline(100, () =>
          withStoreStateLease(storePath, async () => {
            competitorEntered = true;
          })
        )
      ).rejects.toBeInstanceOf(OperationDeadlineExceededError);
      expect(competitorEntered).toBe(false);
      await rm(leasePath, { recursive: true, force: true });
    });
  });

  it("recovers an ownerless recovery gate abandoned before owner publication", async () => {
    await withInitializedTempStore(async (storePath) => {
      const recoveryPath = join(storePath, "state", "store-state.recovery");
      await mkdir(recoveryPath, { mode: 0o700 });
      const staleAt = new Date("2000-01-01T00:00:00.000Z");
      await utimes(recoveryPath, staleAt, staleAt);

      await expect(withStoreStateLease(storePath, async () => "recovered")).resolves.toBe("recovered");
      await expect(stat(recoveryPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("removes a stale recovery publication left by a terminated process", async () => {
    await withInitializedTempStore(async (storePath) => {
      const recoveryPath = join(storePath, "state", "store-state.recovery");
      const pendingPath = `${recoveryPath}.pending-4000000-1-deadbeef`;
      const pendingOwnerPath = join(pendingPath, "owner.json");
      await mkdir(pendingPath, { mode: 0o700 });
      await writeFile(
        pendingOwnerPath,
        `${JSON.stringify({ version: 1, token: "4000000-1-deadbeef", pid: 4_000_000 })}\n`,
        { encoding: "utf8", mode: 0o600 }
      );
      const staleAt = new Date("2000-01-01T00:00:00.000Z");
      await utimes(pendingOwnerPath, staleAt, staleAt);
      await utimes(pendingPath, staleAt, staleAt);

      await expect(withStoreStateLease(storePath, async () => "recovered")).resolves.toBe("recovered");
      await expect(stat(pendingPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("recovers a stale lease left by a terminated process without retaining stale owners", async () => {
    await withInitializedTempStore(async (storePath) => {
      const leaseModule = pathToFileURL(join(process.cwd(), "dist", "core", "state-lease.js")).href;
      const child = spawn(process.execPath, ["--input-type=module", "--eval", CHILD_LEASE_SCRIPT], {
        env: {
          ...process.env,
          MORYN_TEST_LEASE_MODULE: leaseModule,
          MORYN_TEST_STORE_PATH: storePath
        },
        stdio: ["ignore", "pipe", "pipe"]
      });
      try {
        await waitForChildLease(child);
        await killChild(child);

        const leasePath = join(storePath, "state", "store-state.lease");
        const ownerPath = join(leasePath, "owner.json");
        const recoveryPath = join(storePath, "state", "store-state.recovery");
        await expect(stat(ownerPath)).resolves.toBeDefined();
        const staleAt = new Date("2000-01-01T00:00:00.000Z");
        await utimes(ownerPath, staleAt, staleAt);
        await mkdir(recoveryPath, { mode: 0o700 });
        const recoveryOwnerPath = join(recoveryPath, "owner.json");
        await writeFile(
          recoveryOwnerPath,
          `${JSON.stringify({ version: 1, token: "terminated-gate-owner", pid: child.pid })}\n`,
          { encoding: "utf8", mode: 0o600 }
        );
        await utimes(recoveryOwnerPath, staleAt, staleAt);

        let activeOwners = 0;
        let maximumActiveOwners = 0;
        const recovered = await Promise.all(
          Array.from({ length: 12 }, (_, index) =>
            withStoreStateLease(storePath, async () => {
              activeOwners += 1;
              maximumActiveOwners = Math.max(maximumActiveOwners, activeOwners);
              try {
                await delay(5);
                return index;
              } finally {
                activeOwners -= 1;
              }
            })
          )
        );
        expect(recovered).toEqual(Array.from({ length: 12 }, (_, index) => index));
        expect(maximumActiveOwners).toBe(1);
        expect(
          (await readdir(join(storePath, "state"))).filter((entry) => entry.startsWith("store-state.lease"))
        ).toEqual([]);
        await expect(stat(recoveryPath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await killChild(child);
      }
    });
  });
});
