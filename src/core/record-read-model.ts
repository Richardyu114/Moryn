import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  buildMemoryRetentionReadModel,
  MEMORY_LAYERS,
  MEMORY_RETENTION_TIERS,
  type MemoryLayer,
  type MemoryRetentionTier,
  type MemoryRetentionViewOptions,
  type MemoryRetentionViewV2
} from "./memory-retention.js";
import { replayEvents } from "./replay.js";
import { parseRecord } from "./schema.js";
import { type EventFileManifest, readEventFileManifest, readEvents } from "./store.js";
import type { MorynEvent, MorynRecord } from "./types.js";

export interface EventManifest extends EventFileManifest {}

export interface RecordReadModelV1 {
  version: 1;
  generated_at: string;
  event_manifest: EventManifest;
  records: MorynRecord[];
}

export function eventManifest(events: MorynEvent[]): EventManifest {
  const identities = [...events]
    .sort(
      (left, right) => left.created_at.localeCompare(right.created_at) || left.event_id.localeCompare(right.event_id)
    )
    .map((event) => `${event.created_at}\u0000${event.event_id}\u0000${event.op}`);
  return {
    count: identities.length,
    digest: createHash("sha256").update(identities.join("\n")).digest("hex")
  };
}

export function buildRecordReadModel(
  events: MorynEvent[],
  records: MorynRecord[],
  manifest: EventManifest
): RecordReadModelV1 {
  return {
    version: 1,
    generated_at:
      [...events].sort(
        (left, right) => right.created_at.localeCompare(left.created_at) || right.event_id.localeCompare(left.event_id)
      )[0]?.created_at ?? "1970-01-01T00:00:00.000Z",
    event_manifest: manifest,
    records: [...records].sort((left, right) => left.id.localeCompare(right.id))
  };
}

export type RecordReadFallbackReason = "missing" | "invalid" | "version_mismatch" | "stale";

export interface CurrentRecordReadResult {
  records: MorynRecord[];
  source: "read_model" | "event_replay";
  repaired: boolean;
  fallback_reason?: RecordReadFallbackReason;
  event_manifest: EventManifest;
}

export interface ReadCurrentRecordsOptions {
  write_read_model?: (path: string, model: RecordReadModelV1) => Promise<void>;
}

export type MemoryWorkingSetExclusionReason =
  | "cold_tier"
  | "purged_tier"
  | "layer_limit"
  | "layer_token_budget"
  | "total_token_budget";

export interface MemoryWorkingSetSelectionOptions extends MemoryRetentionViewOptions {
  /** Compatibility alias for callers that still describe cold records as archived. */
  include_archived?: boolean;
  include_cold?: boolean;
  include_purged?: boolean;
  /** Per-layer record-count budgets. Omitted or invalid limits leave that layer unbounded. */
  layer_limits?: Partial<Record<MemoryLayer, number>>;
  /** Total estimated-token budget. Mandatory identity/pinned records may overflow it and are reported. */
  total_token_budget?: number;
  /** Per-layer estimated-token budgets with the same mandatory-overflow behavior. */
  layer_token_budgets?: Partial<Record<MemoryLayer, number>>;
}

export interface MemoryWorkingSetEntry {
  record: MorynRecord;
  retention: MemoryRetentionViewV2;
  estimated_tokens: number;
  mandatory: boolean;
}

export interface ExcludedMemoryWorkingSetEntry extends MemoryWorkingSetEntry {
  reason: MemoryWorkingSetExclusionReason;
}

export interface MemoryWorkingSetSelectionCounts {
  total_records: number;
  selected_records: number;
  excluded_records: number;
  selected_layers: Record<MemoryLayer, number>;
  excluded_layers: Record<MemoryLayer, number>;
  selected_tiers: Record<MemoryRetentionTier, number>;
  excluded_tiers: Record<MemoryRetentionTier, number>;
  exclusion_reasons: Record<MemoryWorkingSetExclusionReason, number>;
}

export interface MemoryWorkingSetTokenReport {
  total_estimated_tokens: number;
  selected_estimated_tokens: number;
  omitted_estimated_tokens: number;
  selected_by_layer: Record<MemoryLayer, number>;
  omitted_by_layer: Record<MemoryLayer, number>;
  budgets: {
    total_token_budget?: number;
    layer_token_budgets: Partial<Record<MemoryLayer, number>>;
  };
  overflow: {
    total_tokens: number;
    by_layer: Record<MemoryLayer, number>;
    mandatory_record_ids: string[];
    pinned_record_ids: string[];
  };
}

export interface MemoryWorkingSetSelection {
  selected: MemoryWorkingSetEntry[];
  excluded: ExcludedMemoryWorkingSetEntry[];
  counts: MemoryWorkingSetSelectionCounts;
  tokens: MemoryWorkingSetTokenReport;
}

/** Default active-context ceiling used by Engine boot/recall. Audit reads can opt out or supply another budget. */
export const DEFAULT_MEMORY_WORKING_SET_TOTAL_TOKEN_BUDGET = 16_000;

/** Layer ceilings keep raw evidence and episodes from crowding out durable knowledge. L3 is mandatory and unbounded. */
export const DEFAULT_MEMORY_WORKING_SET_LAYER_TOKEN_BUDGETS = {
  L0: 3_000,
  L1: 4_000,
  L2: 12_000
} as const satisfies Partial<Record<MemoryLayer, number>>;

export const DEFAULT_MEMORY_WORKING_SET_OPTIONS: Readonly<MemoryWorkingSetSelectionOptions> = {
  total_token_budget: DEFAULT_MEMORY_WORKING_SET_TOTAL_TOKEN_BUDGET,
  layer_token_budgets: DEFAULT_MEMORY_WORKING_SET_LAYER_TOKEN_BUDGETS
};

function sameManifest(left: EventManifest, right: EventManifest): boolean {
  return left.count === right.count && left.digest === right.digest;
}

function parseReadModel(value: unknown): RecordReadModelV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
  const model = value as Record<string, unknown>;
  if (model.version !== 1) throw new Error("version_mismatch");
  const manifest = model.event_manifest as Record<string, unknown> | undefined;
  if (
    !manifest ||
    typeof manifest.count !== "number" ||
    typeof manifest.digest !== "string" ||
    !Array.isArray(model.records) ||
    typeof model.generated_at !== "string"
  )
    throw new Error("invalid");
  return {
    version: 1,
    generated_at: model.generated_at,
    event_manifest: { count: manifest.count, digest: manifest.digest },
    records: model.records.map((record) => parseRecord(record))
  };
}

async function writeReadModel(path: string, model: RecordReadModelV1): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(model, null, 2)}\n`, "utf8");
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function authoritativeReplay(
  storePath: string
): Promise<{ events: MorynEvent[]; records: MorynRecord[]; manifest: EventManifest }> {
  let events = await readEvents(storePath);
  let manifest = await readEventFileManifest(storePath);
  if (manifest.count !== events.length) {
    events = await readEvents(storePath);
    manifest = await readEventFileManifest(storePath);
  }
  return { events, records: [...replayEvents(events).values()], manifest };
}

function emptyMemoryCounts<T extends readonly string[]>(values: T): Record<T[number], number> {
  return Object.fromEntries(values.map((value) => [value, 0])) as Record<T[number], number>;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalSelectionValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalSelectionValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([key, nested]) => [key, canonicalSelectionValue(nested)])
    );
  }
  return value;
}

function stableSelectionKey(record: MorynRecord): string {
  return JSON.stringify(canonicalSelectionValue(record));
}

/** Deterministic approximation for budgeting canonical JSON passed through boot/retrieval context. */
export function estimateMemoryRecordTokens(record: MorynRecord): number {
  const serialized = stableSelectionKey(record);
  let asciiBytes = 0;
  let nonAsciiBytes = 0;
  for (const character of serialized) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (bytes === 1) asciiBytes += 1;
    else nonAsciiBytes += bytes;
  }
  return Math.max(1, Math.ceil(asciiBytes / 4 + nonAsciiBytes / 3));
}

function mandatoryWorkingSetEntry(retention: MemoryRetentionViewV2): boolean {
  return retention.layer.level === "L3" || retention.retention.never_forget || retention.retention.pinned;
}

function workingSetPriority(left: MemoryWorkingSetEntry, right: MemoryWorkingSetEntry): number {
  const layerPriority = { L0: 0, L1: 1, L2: 2, L3: 3 } satisfies Record<MemoryLayer, number>;
  const tierPriority = { purged: 0, cold: 1, warm: 2, hot: 3 } satisfies Record<MemoryRetentionTier, number>;
  const recordPriority = { low: 0, normal: 1, high: 2 } as const;
  return (
    layerPriority[right.retention.layer.level] - layerPriority[left.retention.layer.level] ||
    Number(right.retention.retention.never_forget) - Number(left.retention.retention.never_forget) ||
    Number(right.retention.retention.pinned) - Number(left.retention.retention.pinned) ||
    recordPriority[right.record.priority] - recordPriority[left.record.priority] ||
    tierPriority[right.retention.retention.tier] - tierPriority[left.retention.retention.tier] ||
    right.retention.usage.useful_count - left.retention.usage.useful_count ||
    right.retention.usage.recall_count - left.retention.usage.recall_count ||
    compareCodeUnits(right.record.updated_at, left.record.updated_at) ||
    compareCodeUnits(left.record.id, right.record.id) ||
    compareCodeUnits(stableSelectionKey(left.record), stableSelectionKey(right.record))
  );
}

function normalizedLayerLimit(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function normalizedTokenBudgets(
  budgets: MemoryWorkingSetSelectionOptions["layer_token_budgets"]
): Partial<Record<MemoryLayer, number>> {
  const normalized: Partial<Record<MemoryLayer, number>> = {};
  for (const layer of MEMORY_LAYERS) {
    const budget = normalizedLayerLimit(budgets?.[layer]);
    if (budget !== undefined) normalized[layer] = budget;
  }
  return normalized;
}

/**
 * Selects the bounded working set without mutating or truncating the authoritative record snapshot.
 * Identity and durable knowledge are considered before episodic memory and raw evidence.
 */
export function selectMemoryWorkingSet(
  records: readonly MorynRecord[],
  options: MemoryWorkingSetSelectionOptions = {}
): MemoryWorkingSetSelection {
  const retention = buildMemoryRetentionReadModel(records, options);
  const entries = records
    .map((record) => {
      const view = retention.records_by_id[record.id]!;
      return {
        record,
        retention: view,
        estimated_tokens: estimateMemoryRecordTokens(record),
        mandatory: mandatoryWorkingSetEntry(view)
      };
    })
    .sort(workingSetPriority);
  const selected: MemoryWorkingSetEntry[] = [];
  const excluded: ExcludedMemoryWorkingSetEntry[] = [];
  const selectedLayers = emptyMemoryCounts(MEMORY_LAYERS);
  const excludedLayers = emptyMemoryCounts(MEMORY_LAYERS);
  const selectedTiers = emptyMemoryCounts(MEMORY_RETENTION_TIERS);
  const excludedTiers = emptyMemoryCounts(MEMORY_RETENTION_TIERS);
  const exclusionReasons: Record<MemoryWorkingSetExclusionReason, number> = {
    cold_tier: 0,
    purged_tier: 0,
    layer_limit: 0,
    layer_token_budget: 0,
    total_token_budget: 0
  };
  const selectedByLayer = emptyMemoryCounts(MEMORY_LAYERS);
  const selectedTokensByLayer = emptyMemoryCounts(MEMORY_LAYERS);
  const omittedTokensByLayer = emptyMemoryCounts(MEMORY_LAYERS);
  const layerTokenBudgets = normalizedTokenBudgets(options.layer_token_budgets);
  const totalTokenBudget = normalizedLayerLimit(options.total_token_budget);
  const mandatoryOverflowRecordIds = new Set<string>();
  const pinnedOverflowRecordIds = new Set<string>();
  let selectedTokens = 0;
  let omittedTokens = 0;
  const includeCold = options.include_cold === true || options.include_archived === true;

  for (const entry of entries) {
    const layer = entry.retention.layer.level;
    const tier = entry.retention.retention.tier;
    const layerTokenBudget = layerTokenBudgets[layer];
    const exceedsLayerTokenBudget =
      layerTokenBudget !== undefined && selectedTokensByLayer[layer] + entry.estimated_tokens > layerTokenBudget;
    const exceedsTotalTokenBudget =
      totalTokenBudget !== undefined && selectedTokens + entry.estimated_tokens > totalTokenBudget;
    let reason: MemoryWorkingSetExclusionReason | undefined;
    if (tier === "cold" && !includeCold) reason = "cold_tier";
    else if (tier === "purged" && options.include_purged !== true) reason = "purged_tier";
    else {
      const limit = normalizedLayerLimit(options.layer_limits?.[layer]);
      if (limit !== undefined && selectedByLayer[layer] >= limit) reason = "layer_limit";
      else if (!entry.mandatory && exceedsLayerTokenBudget) reason = "layer_token_budget";
      else if (!entry.mandatory && exceedsTotalTokenBudget) reason = "total_token_budget";
    }

    if (reason) {
      excluded.push({ ...entry, reason });
      excludedLayers[layer] += 1;
      excludedTiers[tier] += 1;
      exclusionReasons[reason] += 1;
      omittedTokens += entry.estimated_tokens;
      omittedTokensByLayer[layer] += entry.estimated_tokens;
      continue;
    }
    if (entry.mandatory && (exceedsLayerTokenBudget || exceedsTotalTokenBudget)) {
      mandatoryOverflowRecordIds.add(entry.record.id);
      if (entry.retention.retention.pinned) pinnedOverflowRecordIds.add(entry.record.id);
    }
    selected.push(entry);
    selectedByLayer[layer] += 1;
    selectedLayers[layer] += 1;
    selectedTiers[tier] += 1;
    selectedTokens += entry.estimated_tokens;
    selectedTokensByLayer[layer] += entry.estimated_tokens;
  }

  const overflowByLayer = emptyMemoryCounts(MEMORY_LAYERS);
  for (const layer of MEMORY_LAYERS) {
    const budget = layerTokenBudgets[layer];
    if (budget !== undefined) overflowByLayer[layer] = Math.max(0, selectedTokensByLayer[layer] - budget);
  }

  return {
    selected,
    excluded,
    counts: {
      total_records: entries.length,
      selected_records: selected.length,
      excluded_records: excluded.length,
      selected_layers: selectedLayers,
      excluded_layers: excludedLayers,
      selected_tiers: selectedTiers,
      excluded_tiers: excludedTiers,
      exclusion_reasons: exclusionReasons
    },
    tokens: {
      total_estimated_tokens: selectedTokens + omittedTokens,
      selected_estimated_tokens: selectedTokens,
      omitted_estimated_tokens: omittedTokens,
      selected_by_layer: selectedTokensByLayer,
      omitted_by_layer: omittedTokensByLayer,
      budgets: {
        ...(totalTokenBudget !== undefined ? { total_token_budget: totalTokenBudget } : {}),
        layer_token_budgets: layerTokenBudgets
      },
      overflow: {
        total_tokens: totalTokenBudget === undefined ? 0 : Math.max(0, selectedTokens - totalTokenBudget),
        by_layer: overflowByLayer,
        mandatory_record_ids: [...mandatoryOverflowRecordIds].sort(compareCodeUnits),
        pinned_record_ids: [...pinnedOverflowRecordIds].sort(compareCodeUnits)
      }
    }
  };
}

export async function readCurrentRecords(
  storePath: string,
  options: ReadCurrentRecordsOptions = {}
): Promise<CurrentRecordReadResult> {
  const path = join(storePath, "snapshots", "records.json");
  const before = await readEventFileManifest(storePath);
  let fallbackReason: RecordReadFallbackReason | undefined;
  try {
    const model = parseReadModel(JSON.parse(await readFile(path, "utf8")));
    const after = await readEventFileManifest(storePath);
    if (sameManifest(before, after) && sameManifest(model.event_manifest, after)) {
      return { records: model.records, source: "read_model", repaired: false, event_manifest: after };
    }
    fallbackReason = "stale";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") fallbackReason = "missing";
    else if (error instanceof Error && error.message === "version_mismatch") fallbackReason = "version_mismatch";
    else fallbackReason = "invalid";
  }

  const replay = await authoritativeReplay(storePath);
  let repaired = false;
  try {
    await (options.write_read_model ?? writeReadModel)(
      path,
      buildRecordReadModel(replay.events, replay.records, replay.manifest)
    );
    repaired = true;
  } catch {}
  return {
    records: replay.records,
    source: "event_replay",
    repaired,
    fallback_reason: fallbackReason,
    event_manifest: replay.manifest
  };
}
