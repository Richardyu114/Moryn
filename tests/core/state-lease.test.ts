import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
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
