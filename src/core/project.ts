import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";

export function projectIdFromPath(projectPath: string): string {
  const resolved = resolve(projectPath);
  const name = basename(resolved) || "project";
  const hash = createHash("sha1").update(resolved).digest("hex").slice(0, 8);
  return `${name}-${hash}`;
}
