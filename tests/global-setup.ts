import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Build the TypeScript sources to dist/ once before the whole suite runs.
 * The CLI and MCP child-process tests launch the pre-compiled dist/ with plain
 * node (instead of tsx compiling src/ on every spawn), so dist must be current.
 */
export default async function setup(): Promise<void> {
  await exec("npm", ["run", "build"], { cwd: repoRoot });
}
