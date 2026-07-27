import { createHash } from "node:crypto";

const READABLE_PROJECT_ID = /^[a-z0-9][a-z0-9_-]{0,119}$/;
const WINDOWS_RESERVED_FILE_STEM = /^(?:aux|con|nul|prn|com[1-9]|lpt[1-9])$/;

/**
 * Produces a deterministic, cross-platform-safe project artifact filename.
 * Short conventional ids stay readable; every other id is represented by a
 * fixed-width digest so remote input cannot exceed filesystem name limits.
 */
export function projectArtifactFileName(projectId: string): string {
  const stem =
    READABLE_PROJECT_ID.test(projectId) && !WINDOWS_RESERVED_FILE_STEM.test(projectId)
      ? projectId
      : `~${createHash("sha256").update(projectId, "utf8").digest("hex")}`;
  return `${stem}.json`;
}
