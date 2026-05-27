import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface GitSyncStatus {
  configured: boolean;
  branch?: string;
  remote?: string;
  error?: string;
}

export async function getGitSyncStatus(cwd: string): Promise<GitSyncStatus> {
  try {
    const [{ stdout: branch }, { stdout: remote }] = await Promise.all([
      exec("git", ["branch", "--show-current"], { cwd }),
      exec("git", ["remote", "get-url", "origin"], { cwd })
    ]);
    return { configured: true, branch: branch.trim(), remote: remote.trim() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { configured: false, error: message };
  }
}
