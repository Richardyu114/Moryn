import type { SemanticConsolidationProposalResult } from "./semantic-consolidation.js";
import type { RecordSource } from "./types.js";

export const AUTOMATIC_SEMANTIC_MAINTENANCE_MAX_MERGES = 1;

export interface AutomaticSemanticMaintenanceInput {
  project_id: string;
  source: RecordSource;
}

export interface AutomaticSemanticMaintenanceResult {
  status: "committed" | "skipped" | "failed";
  project_id: string;
  maximum_merges: 1;
  drafts_ready: number;
  merges_attempted: number;
  merges_committed: number;
  before: { current_records: number; estimated_tokens: number };
  after: { current_records: number; estimated_tokens: number };
  committed: Array<{
    draft_id: string;
    merged_record_id: string;
    source_record_ids: string[];
    projected_record_reduction: 1;
    projected_token_reduction: number;
    result: SemanticConsolidationProposalResult;
  }>;
  failures: Array<{
    draft_id?: string;
    reason: string;
  }>;
  proof: {
    strict_record_decrease_required: true;
    strict_token_decrease_required: true;
    strict_record_decrease_observed: boolean;
    strict_token_decrease_observed: boolean;
    source_history_retained: true;
    physical_delete: false;
  };
}

interface AutomaticSemanticMaintenanceEngine {
  applyAutomaticSemanticMaintenance(
    input: AutomaticSemanticMaintenanceInput
  ): Promise<AutomaticSemanticMaintenanceResult>;
}

export async function runAutomaticSemanticMaintenance(
  engine: AutomaticSemanticMaintenanceEngine,
  input: AutomaticSemanticMaintenanceInput
): Promise<AutomaticSemanticMaintenanceResult> {
  try {
    return await engine.applyAutomaticSemanticMaintenance(input);
  } catch (error) {
    return {
      status: "failed",
      project_id: input.project_id,
      maximum_merges: AUTOMATIC_SEMANTIC_MAINTENANCE_MAX_MERGES,
      drafts_ready: 0,
      merges_attempted: 0,
      merges_committed: 0,
      before: { current_records: 0, estimated_tokens: 0 },
      after: { current_records: 0, estimated_tokens: 0 },
      committed: [],
      failures: [{ reason: error instanceof Error ? error.message : String(error) }],
      proof: {
        strict_record_decrease_required: true,
        strict_token_decrease_required: true,
        strict_record_decrease_observed: false,
        strict_token_decrease_observed: false,
        source_history_retained: true,
        physical_delete: false
      }
    };
  }
}
