import { chmod, link, mkdir, open, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { EpisodeRollupPlan } from "./episode-rollup.js";
import { buildEpisodeRollupEvents } from "./episode-rollup-transaction.js";
import { memoryCompactionDigest, sameMemoryCompactionValue } from "./memory-compaction-integrity.js";

export interface AutomaticEpisodeRollupRecoveryPlan {
  version: 1;
  status: "pending";
  plan: EpisodeRollupPlan;
  integrity_digest: string;
}

const RECOVERY_DIRECTORY = "automatic-episode-rollup";

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertPlanId(planId: string): void {
  if (!/^episode_rollup_[a-f0-9]{32}$/u.test(planId)) {
    throw new Error("Invalid Automatic Episode Rollup recovery plan id");
  }
}

function recoveryProjectDirectory(storePath: string, projectId: string): string {
  const projectDigest = memoryCompactionDigest({ project_id: projectId }).slice(0, 32);
  return join(storePath, "state", RECOVERY_DIRECTORY, projectDigest);
}

function recoveryRootDirectory(storePath: string): string {
  return join(storePath, "state", RECOVERY_DIRECTORY);
}

function recoveryPrivacyDirectory(
  storePath: string,
  projectId: string,
  privacy: Exclude<EpisodeRollupPlan["privacy_boundary"], "mixed">
): string {
  return join(recoveryProjectDirectory(storePath, projectId), privacy);
}

function recoveryPlanPath(storePath: string, plan: EpisodeRollupPlan): string {
  assertPlanId(plan.plan_id);
  if (plan.privacy_boundary === "mixed") {
    throw new Error("Mixed-private Automatic Episode Rollup plans cannot be persisted for recovery");
  }
  return join(
    recoveryPrivacyDirectory(storePath, plan.identity.project_id, plan.privacy_boundary),
    `${plan.plan_id}.json`
  );
}

function recoveryPayload(plan: EpisodeRollupPlan): Omit<AutomaticEpisodeRollupRecoveryPlan, "integrity_digest"> {
  return { version: 1, status: "pending", plan };
}

function assertAutomaticRecoveryPlan(
  plan: EpisodeRollupPlan,
  projectId: string
): asserts plan is EpisodeRollupPlan & {
  privacy_boundary: Exclude<EpisodeRollupPlan["privacy_boundary"], "mixed">;
} {
  buildEpisodeRollupEvents(plan);
  const uniformPrivacy =
    (plan.privacy_boundary === "public" || plan.privacy_boundary === "private") &&
    plan.source_digests.every((source) => source.privacy === plan.privacy_boundary);
  if (
    plan.identity.project_id !== projectId ||
    plan.identity.bucket_kind !== "day" ||
    plan.status !== "ready" ||
    !plan.auto_rollup ||
    !uniformPrivacy
  ) {
    throw new Error("Automatic Episode Rollup recovery plan is outside the automatic safety boundary");
  }
}

function parseRecoveryPlan(value: unknown, projectId: string): AutomaticEpisodeRollupRecoveryPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Automatic Episode Rollup recovery plan is corrupt or tampered");
  }
  const artifact = value as Partial<AutomaticEpisodeRollupRecoveryPlan>;
  if (
    artifact.version !== 1 ||
    artifact.status !== "pending" ||
    !artifact.plan ||
    typeof artifact.plan !== "object" ||
    typeof artifact.integrity_digest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(artifact.integrity_digest)
  ) {
    throw new Error("Automatic Episode Rollup recovery plan is corrupt or tampered");
  }
  const payload = recoveryPayload(artifact.plan);
  if (memoryCompactionDigest(payload) !== artifact.integrity_digest) {
    throw new Error("Automatic Episode Rollup recovery plan is corrupt or tampered");
  }
  assertAutomaticRecoveryPlan(artifact.plan, projectId);
  return { ...payload, integrity_digest: artifact.integrity_digest };
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureRecoveryDirectory(storePath: string, plan: EpisodeRollupPlan): Promise<string> {
  if (plan.privacy_boundary === "mixed") {
    throw new Error("Mixed-private Automatic Episode Rollup plans cannot be persisted for recovery");
  }
  const stateDirectory = join(storePath, "state");
  const rootDirectory = recoveryRootDirectory(storePath);
  const projectDirectory = recoveryProjectDirectory(storePath, plan.identity.project_id);
  const privacyDirectory = recoveryPrivacyDirectory(storePath, plan.identity.project_id, plan.privacy_boundary);
  await mkdir(privacyDirectory, { recursive: true, mode: 0o700 });
  for (const directory of [rootDirectory, projectDirectory, privacyDirectory]) await chmod(directory, 0o700);
  for (const directory of [stateDirectory, rootDirectory, projectDirectory]) await syncDirectory(directory);
  return privacyDirectory;
}

async function readRecoveryPlanFile(
  path: string,
  projectId: string,
  privacy: Exclude<EpisodeRollupPlan["privacy_boundary"], "mixed">
): Promise<AutomaticEpisodeRollupRecoveryPlan | undefined> {
  try {
    const artifact = parseRecoveryPlan(JSON.parse(await readFile(path, "utf8")), projectId);
    if (artifact.plan.privacy_boundary !== privacy) {
      throw new Error("Automatic Episode Rollup recovery plan path does not match its plan");
    }
    return artifact;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function persistAutomaticEpisodeRollupRecoveryPlan(
  storePath: string,
  plan: EpisodeRollupPlan
): Promise<void> {
  assertAutomaticRecoveryPlan(plan, plan.identity.project_id);
  const path = recoveryPlanPath(storePath, plan);
  const directory = await ensureRecoveryDirectory(storePath, plan);
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const payload = recoveryPayload(plan);
  const artifact: AutomaticEpisodeRollupRecoveryPlan = {
    ...payload,
    integrity_digest: memoryCompactionDigest(payload)
  };
  const existing = await readRecoveryPlanFile(path, plan.identity.project_id, plan.privacy_boundary);
  if (existing) {
    if (!sameMemoryCompactionValue(existing, artifact)) {
      throw new Error("Automatic Episode Rollup recovery plan collision or corruption");
    }
    await chmod(path, 0o600);
    await syncDirectory(directory);
    return;
  }
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporary, 0o600);
    try {
      await link(temporary, path);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      const raced = await readRecoveryPlanFile(path, plan.identity.project_id, plan.privacy_boundary);
      if (!raced || !sameMemoryCompactionValue(raced, artifact)) {
        throw new Error("Automatic Episode Rollup recovery plan collision or corruption");
      }
    }
    await chmod(path, 0o600);
    await syncDirectory(directory);
  } finally {
    await rm(temporary, { force: true });
  }
  const readback = await readRecoveryPlanFile(path, plan.identity.project_id, plan.privacy_boundary);
  if (!readback || !sameMemoryCompactionValue(readback, artifact)) {
    throw new Error("Automatic Episode Rollup recovery plan durability readback failed");
  }
}

export async function removeAutomaticEpisodeRollupRecoveryPlan(
  storePath: string,
  plan: EpisodeRollupPlan
): Promise<void> {
  await rm(recoveryPlanPath(storePath, plan), { force: true });
}

async function recoveryPlanNames(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^episode_rollup_[a-f0-9]{32}\.json$/u.test(entry.name))
      .map((entry) => entry.name)
      .sort(compareCodeUnits);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

export async function countPrivateAutomaticEpisodeRollupRecoveryPlans(
  storePath: string,
  projectId: string
): Promise<number> {
  const normalizedProjectId = projectId.trim();
  if (!normalizedProjectId) throw new Error("Automatic Episode Rollup recovery requires project_id");
  return (await recoveryPlanNames(recoveryPrivacyDirectory(storePath, normalizedProjectId, "private"))).length;
}

export async function readAutomaticEpisodeRollupRecoveryPlans(
  storePath: string,
  projectId: string,
  options: { include_private?: boolean } = {}
): Promise<AutomaticEpisodeRollupRecoveryPlan[]> {
  const normalizedProjectId = projectId.trim();
  if (!normalizedProjectId) throw new Error("Automatic Episode Rollup recovery requires project_id");
  const privacyBoundaries: Exclude<EpisodeRollupPlan["privacy_boundary"], "mixed">[] =
    options.include_private === true ? ["public", "private"] : ["public"];
  const plans: AutomaticEpisodeRollupRecoveryPlan[] = [];
  for (const privacy of privacyBoundaries) {
    const directory = recoveryPrivacyDirectory(storePath, normalizedProjectId, privacy);
    for (const name of await recoveryPlanNames(directory)) {
      const artifact = await readRecoveryPlanFile(join(directory, name), normalizedProjectId, privacy);
      if (!artifact || `${artifact.plan.plan_id}.json` !== name) {
        throw new Error("Automatic Episode Rollup recovery plan path does not match its plan");
      }
      plans.push(artifact);
    }
  }
  return plans.sort((left, right) => compareCodeUnits(left.plan.plan_id, right.plan.plan_id));
}
