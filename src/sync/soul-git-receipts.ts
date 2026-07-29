import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  execOperationChildProcess,
  rethrowIfOperationDeadlineExceeded,
  spawnOperationChildProcess
} from "../core/operation-deadline.js";
import { parseEvent } from "../core/schema.js";
import {
  parseSoulProfileProjection,
  readSoulProfileRevisions,
  SOUL_PROFILE_RECORD_TYPE,
  type SoulProfileProjectionEnvelope
} from "../core/soul-profile-store.js";
import {
  listSoulSyncReceipts,
  type SoulSyncReceiptOperation,
  type SoulSyncReceiptStage,
  soulRemoteIdentityDigest,
  writeSoulSyncReceipt
} from "../core/soul-sync-receipts.js";
import type { MorynEvent } from "../core/types.js";

const SOUL_EVENT_PATH_PATTERN = /^events\/idempotent\/evt_soul_[a-f0-9]{32}\.json$/u;
const GIT_ERROR_BUFFER_LIMIT = 64 * 1024;

interface GitSoulProjectionEvidence {
  event: Extract<MorynEvent, { op: "upsert_record" }>;
  envelope: SoulProfileProjectionEnvelope;
  event_path: string;
  event_blob_oid: string;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execOperationChildProcess("git", args, { cwd });
  return stdout.trim();
}

async function gitRaw(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execOperationChildProcess("git", args, { cwd });
  return stdout;
}

function parseSoulTreeEntry(raw: Buffer): { path: string; blob_oid: string } | undefined {
  const entry = raw.toString("utf8");
  const separator = entry.indexOf("\t");
  if (separator < 0) return undefined;
  const [mode, type, blobOid] = entry.slice(0, separator).split(" ");
  const path = entry.slice(separator + 1);
  if (!mode?.startsWith("100") || type !== "blob" || !blobOid || !SOUL_EVENT_PATH_PATTERN.test(path)) {
    return undefined;
  }
  return { path, blob_oid: blobOid };
}

async function streamSoulTreeEntries(
  storePath: string,
  commit: string
): Promise<Array<{ path: string; blob_oid: string }>> {
  return new Promise((resolve, reject) => {
    const args = ["ls-tree", "-r", "-z", commit, "--", "events/idempotent"];
    const spawned = spawnOperationChildProcess("git", args, { cwd: storePath });
    const { child } = spawned;
    child.stdin.end();
    const entries: Array<{ path: string; blob_oid: string }> = [];
    let pending = Buffer.alloc(0);
    let errorOutput = Buffer.alloc(0);

    child.stdout.on("data", (chunk: Buffer) => {
      const output = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      let start = 0;
      for (let separator = output.indexOf(0, start); separator >= 0; separator = output.indexOf(0, start)) {
        const entry = parseSoulTreeEntry(output.subarray(start, separator));
        if (entry) entries.push(entry);
        start = separator + 1;
      }
      pending = Buffer.from(output.subarray(start));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errorOutput.length >= GIT_ERROR_BUFFER_LIMIT) return;
      errorOutput = Buffer.concat([errorOutput, chunk.subarray(0, GIT_ERROR_BUFFER_LIMIT - errorOutput.length)]);
    });
    void spawned.completed.then((result) => {
      const childError = result.termination_error ?? result.spawn_error;
      if (childError) {
        reject(childError);
        return;
      }
      if (result.code !== 0) {
        reject(
          new Error(
            `git ls-tree failed with exit code ${result.code ?? "unknown"}: ${errorOutput.toString("utf8").trim()}`
          )
        );
        return;
      }
      if (pending.length !== 0) {
        reject(new Error("git ls-tree returned an unterminated entry"));
        return;
      }
      resolve(entries);
    });
  });
}

async function soulProjectionEvidenceAtCommit(storePath: string, commit: string): Promise<GitSoulProjectionEvidence[]> {
  const tree = await streamSoulTreeEntries(storePath, commit);
  const evidence: GitSoulProjectionEvidence[] = [];
  for (const entry of tree) {
    try {
      const event = parseEvent(JSON.parse(await gitRaw(storePath, ["cat-file", "blob", entry.blob_oid])));
      if (
        event.op !== "upsert_record" ||
        entry.path !== `events/idempotent/${event.event_id}.json` ||
        event.record.kind !== "soul" ||
        event.record.type !== SOUL_PROFILE_RECORD_TYPE
      ) {
        continue;
      }
      const envelope = parseSoulProfileProjection(event.record.content.soul_profile_projection);
      if (envelope.projection !== "personal_sync") continue;
      evidence.push({ event, envelope, event_path: entry.path, event_blob_oid: entry.blob_oid });
    } catch (error) {
      rethrowIfOperationDeadlineExceeded(error);
      // Invalid projections remain synchronized as ordinary Git data but do not gain proof state.
    }
  }
  return evidence.sort(
    (left, right) =>
      compareCodeUnits(left.envelope.revision.profile_id, right.envelope.revision.profile_id) ||
      compareCodeUnits(left.envelope.full_revision_id, right.envelope.full_revision_id) ||
      compareCodeUnits(left.event.event_id, right.event.event_id)
  );
}

export async function captureSoulGitFetchRemoteIdentityDigest(storePath: string): Promise<string> {
  return soulRemoteIdentityDigest(await git(storePath, ["remote", "get-url", "origin"]));
}

export async function captureSoulGitPushRemoteIdentityDigest(storePath: string): Promise<string> {
  // Without --all, Git deterministically returns the first effective push URL.
  // A successful push with multiple pushurl entries includes that target, so a
  // receipt binds one actual destination rather than the unrelated fetch URL.
  return soulRemoteIdentityDigest(await git(storePath, ["remote", "get-url", "--push", "origin"]));
}

async function localEventMatchesEvidence(storePath: string, evidence: GitSoulProjectionEvidence): Promise<boolean> {
  try {
    if ((await git(storePath, ["hash-object", "--", evidence.event_path])) !== evidence.event_blob_oid) return false;
    const localEvent = parseEvent(JSON.parse(await readFile(join(storePath, evidence.event_path), "utf8")));
    if (localEvent.op !== "upsert_record" || localEvent.event_id !== evidence.event.event_id) return false;
    const localEnvelope = parseSoulProfileProjection(localEvent.record.content.soul_profile_projection);
    return (
      localEnvelope.projection === "personal_sync" &&
      localEnvelope.full_revision_id === evidence.envelope.full_revision_id &&
      localEnvelope.integrity_digest === evidence.envelope.integrity_digest
    );
  } catch (error) {
    rethrowIfOperationDeadlineExceeded(error);
    return false;
  }
}

async function writeGitSoulSyncReceipts(
  storePath: string,
  input: {
    stage: SoulSyncReceiptStage;
    operation: SoulSyncReceiptOperation;
    commit: string;
    evidence: GitSoulProjectionEvidence[];
    remote_identity_digest: string;
    verified_revision_ids?: ReadonlySet<string>;
    collision_revision_ids?: ReadonlySet<string>;
  }
): Promise<void> {
  const existing = await listSoulSyncReceipts(storePath);
  const alreadyProven = new Set(
    existing
      .filter(
        (receipt) => receipt.stage === input.stage && receipt.remote_identity_digest === input.remote_identity_digest
      )
      .map((receipt) => `${receipt.revision_id}\0${receipt.event_id}`)
  );
  for (const evidence of input.evidence) {
    const revision = evidence.envelope.revision;
    const identity = `${revision.revision_id}\0${evidence.event.event_id}`;
    if (alreadyProven.has(identity) || input.collision_revision_ids?.has(revision.revision_id)) continue;
    const approvalVerification =
      input.stage === "remote_pushed"
        ? "not_checked"
        : revision.approved
          ? input.verified_revision_ids?.has(revision.revision_id)
            ? "verified"
            : undefined
          : "not_required";
    if (!approvalVerification) continue;
    await writeSoulSyncReceipt(storePath, {
      stage: input.stage,
      operation: input.operation,
      profile_id: revision.profile_id,
      revision_id: revision.revision_id,
      event_id: evidence.event.event_id,
      event_path: evidence.event_path,
      event_blob_oid: evidence.event_blob_oid,
      projection_integrity_digest: evidence.envelope.integrity_digest,
      approval_verification: approvalVerification,
      remote_name: "origin",
      remote_ref: "refs/heads/main",
      remote_identity_digest: input.remote_identity_digest,
      remote_commit: input.commit
    });
    alreadyProven.add(identity);
  }
}

export async function recordPushedSoulSyncReceipts(
  storePath: string,
  remoteIdentityDigest: string,
  pushedCommit: string
): Promise<void> {
  await writeGitSoulSyncReceipts(storePath, {
    stage: "remote_pushed",
    operation: "push",
    commit: pushedCommit,
    evidence: await soulProjectionEvidenceAtCommit(storePath, pushedCommit),
    remote_identity_digest: remoteIdentityDigest
  });
}

export async function recordPulledAndVerifiedSoulSyncReceipts(
  storePath: string,
  operation: Extract<SoulSyncReceiptOperation, "init" | "pull">,
  remoteIdentityDigest: string,
  pulledCommit: string
): Promise<void> {
  const remoteEvidence = await soulProjectionEvidenceAtCommit(storePath, pulledCommit);
  const localEvidence: GitSoulProjectionEvidence[] = [];
  for (const evidence of remoteEvidence) {
    if (await localEventMatchesEvidence(storePath, evidence)) localEvidence.push(evidence);
  }
  const digestsByRevision = new Map<string, Set<string>>();
  for (const evidence of remoteEvidence) {
    const digests = digestsByRevision.get(evidence.envelope.full_revision_id) ?? new Set<string>();
    digests.add(evidence.envelope.integrity_digest);
    digestsByRevision.set(evidence.envelope.full_revision_id, digests);
  }
  const collisionRevisionIds = new Set(
    [...digestsByRevision.entries()].filter(([, digests]) => digests.size > 1).map(([revisionId]) => revisionId)
  );
  const loaded = await readSoulProfileRevisions(storePath, {
    records: remoteEvidence.map((evidence) => evidence.event.record),
    include_local_projections: false
  });
  await writeGitSoulSyncReceipts(storePath, {
    stage: "remote_pulled_and_verified",
    operation,
    commit: pulledCommit,
    evidence: localEvidence,
    remote_identity_digest: remoteIdentityDigest,
    verified_revision_ids: new Set(loaded.verified_approval_revision_ids),
    collision_revision_ids: collisionRevisionIds
  });
}
