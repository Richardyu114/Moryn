#!/usr/bin/env node

import { join } from "node:path";
import { homedir } from "node:os";
import { Command } from "commander";
import { version } from "./index.js";
import { initializeStore } from "./core/config.js";
import { createEngine } from "./core/engine.js";
import { initializeProjectConfig, resolveProjectContext } from "./core/project.js";
import { runMcpServer } from "./mcp/server.js";
import { getGitSyncStatus } from "./sync/git.js";

const program = new Command();

function storePath(): string {
  return program.opts<{ store?: string }>().store ?? join(homedir(), ".memora");
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

program
  .name("mem")
  .description("Memora CLI")
  .version(version)
  .option("--store <path>", "Override Memora store path");

program.command("init").action(async () => {
  printJson({ ok: true, ...await initializeStore(storePath()) });
});

program.command("write")
  .requiredOption("--kind <kind>")
  .requiredOption("--type <type>")
  .requiredOption("--scope <scope>")
  .option("--project-id <id>")
  .option("--project <path>")
  .requiredOption("--text <text>")
  .action(async (options) => {
    const engine = createEngine({ storePath: storePath() });
    const project = await resolveProjectContext({ projectPath: options.project, projectId: options.projectId });
    const result = await engine.write({
      kind: options.kind,
      type: options.type,
      scope: options.scope,
      project_id: project.project_id,
      tags: project.config?.tags,
      content: { text: options.text, format: "text" },
      source: { client: "cli" }
    });
    printJson(result);
  });

program.command("recall")
  .argument("[query]", "Search query")
  .option("--project-id <id>")
  .option("--project <path>")
  .option("--limit <n>", "Result limit", "10")
  .action(async (query, options) => {
    const engine = createEngine({ storePath: storePath() });
    const project = await resolveProjectContext({ projectPath: options.project, projectId: options.projectId });
    printJson(await engine.recall({ query, project_id: project.project_id, limit: Number(options.limit) }));
  });

program.command("boot")
  .option("--project-id <id>")
  .option("--project <path>")
  .action(async (options) => {
    const engine = createEngine({ storePath: storePath() });
    const project = await resolveProjectContext({ projectPath: options.project, projectId: options.projectId });
    printJson(await engine.boot({ project_id: project.project_id }));
  });

program.command("revise")
  .argument("<record-id>")
  .requiredOption("--set <assignment>")
  .option("--reason <reason>")
  .action(async (recordId, options) => {
    const [key, ...rest] = String(options.set).split("=");
    const engine = createEngine({ storePath: storePath() });
    printJson(await engine.revise({ record_id: recordId, patch: { [key]: rest.join("=") }, reason: options.reason, source: { client: "cli" } }));
  });

program.command("promote")
  .argument("<record-id>")
  .requiredOption("--state <state>")
  .option("--reason <reason>")
  .action(async (recordId, options) => {
    const engine = createEngine({ storePath: storePath() });
    printJson(await engine.promote({ record_id: recordId, target_state: options.state, reason: options.reason, source: { client: "cli" } }));
  });

program.command("list-recent")
  .option("--limit <n>", "Result limit", "20")
  .action(async (options) => {
    const engine = createEngine({ storePath: storePath() });
    printJson(await engine.listRecent(Number(options.limit)));
  });

program.command("mcp").action(async () => {
  const engine = createEngine({ storePath: storePath() });
  await runMcpServer(engine);
});

const project = program.command("project");

project.command("init")
  .option("--path <path>", "Project path", process.cwd())
  .option("--project-id <id>")
  .option("--tag <tag>", "Project tag", (value: string, previous: string[] = []) => [...previous, value], [])
  .option("--sync-mode <mode>", "Sync mode", "session")
  .action(async (options) => {
    printJson({
      ok: true,
      ...await initializeProjectConfig(options.path, {
        project_id: options.projectId,
        tags: options.tag,
        sync: { mode: options.syncMode }
      })
    });
  });

program.command("sync")
  .option("--status", "Show sync status")
  .action(async () => {
    printJson(await getGitSyncStatus(process.cwd()));
  });

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
