import type { RecordKind, RecordSource } from "./types.js";

export const AUTOMATIC_EXACT_DUPLICATE_RECORD_KINDS = [
  "memory",
  "skill",
  "soul"
] as const satisfies readonly RecordKind[];

export interface ExactDuplicateConsolidationInput {
  project_id?: string;
  include_private?: boolean;
  record_kinds?: readonly RecordKind[];
  active_logical_only?: boolean;
  skip_conflicted?: boolean;
  exclude_global?: boolean;
  source?: RecordSource;
}

export interface ExactDuplicateConsolidationGroup {
  target_record_id: string;
  duplicate_record_ids: string[];
}

export interface ExactDuplicateConsolidationReceipt {
  groups_found: number;
  links_created: number;
  links_existing: number;
  groups: ExactDuplicateConsolidationGroup[];
}

export type AutomaticExactDuplicateConsolidationResult =
  | (ExactDuplicateConsolidationReceipt & {
      status: "completed";
      project_id: string;
      privacy_boundary: "public";
      record_kinds: typeof AUTOMATIC_EXACT_DUPLICATE_RECORD_KINDS;
    })
  | {
      status: "failed";
      project_id: string;
      privacy_boundary: "public";
      record_kinds: typeof AUTOMATIC_EXACT_DUPLICATE_RECORD_KINDS;
      reason: string;
    };

interface ExactDuplicateConsolidationEngine {
  consolidateExactDuplicates(input: ExactDuplicateConsolidationInput): Promise<ExactDuplicateConsolidationReceipt>;
}

/**
 * Lifecycle maintenance is deliberately narrower than the general Engine operation:
 * public, project-owned durable memory only, excluding already-hidden or conflicted facts.
 */
export async function runAutomaticExactDuplicateConsolidation(
  engine: ExactDuplicateConsolidationEngine,
  input: { project_id: string; source: RecordSource }
): Promise<AutomaticExactDuplicateConsolidationResult> {
  const boundary = {
    project_id: input.project_id,
    privacy_boundary: "public" as const,
    record_kinds: AUTOMATIC_EXACT_DUPLICATE_RECORD_KINDS
  };
  try {
    return {
      status: "completed",
      ...boundary,
      ...(await engine.consolidateExactDuplicates({
        project_id: input.project_id,
        include_private: false,
        record_kinds: AUTOMATIC_EXACT_DUPLICATE_RECORD_KINDS,
        active_logical_only: true,
        skip_conflicted: true,
        exclude_global: true,
        source: input.source
      }))
    };
  } catch (error) {
    return {
      status: "failed",
      ...boundary,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}
