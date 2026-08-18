import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { HostAdapterId } from "./host-adapter-registry.js";

export const PENDING_HOST_FOLLOW_UP_TTL_MS = 24 * 60 * 60 * 1_000;
export const PENDING_HOST_FOLLOW_UP_ACTION_LIMIT_BYTES = 64 * 1_024;

export type JsonSafeValue = null | boolean | number | string | JsonSafeValue[] | { [key: string]: JsonSafeValue };

export interface PendingHostFollowUpIdentity {
  project_id: string;
  host: HostAdapterId;
  session_id: string;
  device_id: string;
}

export interface PendingHostFollowUp extends PendingHostFollowUpIdentity {
  version: 1;
  action: JsonSafeValue;
  created_at: string;
  expires_at: string;
}

export interface WritePendingHostFollowUpInput extends PendingHostFollowUpIdentity {
  action: unknown;
}

export interface PendingHostFollowUpClockOptions {
  now?: () => string;
}

const DIRECTORY = "pending-host-follow-ups";
const hostSchema = z.enum(["claude", "codex", "gemini", "cursor", "opencode", "shell"]);
const identitySchema = z
  .object({
    project_id: z.string().trim().min(1).max(1_024),
    host: hostSchema,
    session_id: z.string().trim().min(1).max(1_024),
    device_id: z.string().trim().min(1).max(1_024)
  })
  .strict();
const canonicalTimestampSchema = z
  .string()
  .refine(
    (value) => Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value,
    "must be a canonical ISO timestamp"
  );
const jsonSafeValueSchema: z.ZodType<JsonSafeValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(jsonSafeValueSchema),
    z.record(z.string(), jsonSafeValueSchema)
  ])
);
const writeInputSchema = identitySchema
  .extend({
    action: jsonSafeValueSchema
  })
  .strict();
const envelopeSchema = identitySchema
  .extend({
    version: z.literal(1),
    action: jsonSafeValueSchema,
    created_at: canonicalTimestampSchema,
    expires_at: canonicalTimestampSchema
  })
  .strict();

function identityKey(identity: PendingHostFollowUpIdentity): string {
  return JSON.stringify({
    project_id: identity.project_id,
    host: identity.host,
    session_id: identity.session_id,
    device_id: identity.device_id
  });
}

function parseIdentity(input: PendingHostFollowUpIdentity): PendingHostFollowUpIdentity {
  return identitySchema.parse(input) as PendingHostFollowUpIdentity;
}

function timestamp(options: PendingHostFollowUpClockOptions): string {
  return canonicalTimestampSchema.parse(options.now?.() ?? new Date().toISOString());
}

function actionSize(action: JsonSafeValue): number {
  return Buffer.byteLength(JSON.stringify(action), "utf8");
}

function assertBoundedAction(action: JsonSafeValue): void {
  if (actionSize(action) > PENDING_HOST_FOLLOW_UP_ACTION_LIMIT_BYTES) {
    throw new Error(
      `Invalid pending host follow-up action: serialized action exceeds ${PENDING_HOST_FOLLOW_UP_ACTION_LIMIT_BYTES} bytes`
    );
  }
}

export function pendingHostFollowUpPath(storePath: string, input: PendingHostFollowUpIdentity): string {
  const identity = parseIdentity(input);
  const digest = createHash("sha256").update(identityKey(identity)).digest("hex");
  return join(storePath, "state", DIRECTORY, `${digest}.json`);
}

export async function writePendingHostFollowUp(
  storePath: string,
  input: WritePendingHostFollowUpInput,
  options: PendingHostFollowUpClockOptions = {}
): Promise<PendingHostFollowUp> {
  const parsed = writeInputSchema.parse(input);
  assertBoundedAction(parsed.action);
  const createdAt = timestamp(options);
  const envelope: PendingHostFollowUp = {
    version: 1,
    project_id: parsed.project_id,
    host: parsed.host,
    session_id: parsed.session_id,
    device_id: parsed.device_id,
    action: parsed.action,
    created_at: createdAt,
    expires_at: new Date(Date.parse(createdAt) + PENDING_HOST_FOLLOW_UP_TTL_MS).toISOString()
  };
  const path = pendingHostFollowUpPath(storePath, {
    project_id: envelope.project_id,
    host: envelope.host,
    session_id: envelope.session_id,
    device_id: envelope.device_id
  });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  try {
    await writeFile(temporary, `${JSON.stringify(envelope, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
  return envelope;
}

export async function readPendingHostFollowUp(
  storePath: string,
  input: PendingHostFollowUpIdentity,
  options: PendingHostFollowUpClockOptions = {}
): Promise<PendingHostFollowUp | undefined> {
  const identity = parseIdentity(input);
  try {
    const parsed = envelopeSchema.safeParse(
      JSON.parse(await readFile(pendingHostFollowUpPath(storePath, identity), "utf8"))
    );
    if (!parsed.success) return undefined;
    const envelope = parsed.data as PendingHostFollowUp;
    if (identityKey(envelope) !== identityKey(identity)) return undefined;
    if (actionSize(envelope.action) > PENDING_HOST_FOLLOW_UP_ACTION_LIMIT_BYTES) return undefined;
    const expectedExpiry = new Date(Date.parse(envelope.created_at) + PENDING_HOST_FOLLOW_UP_TTL_MS).toISOString();
    if (envelope.expires_at !== expectedExpiry) return undefined;
    if (Date.parse(timestamp(options)) >= Date.parse(envelope.expires_at)) return undefined;
    return envelope;
  } catch {
    return undefined;
  }
}
