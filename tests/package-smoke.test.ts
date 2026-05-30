import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "moryn-package-smoke-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("published package smoke", () => {
  it("installs the packed CLI and runs memory operations from dist", async () => {
    await withTempDir(async (dir) => {
      const store = join(dir, "store");
      const project = join(dir, "project");
      const pack = await exec("npm", ["pack", "--silent"], { cwd: process.cwd() });
      const tarball = join(process.cwd(), pack.stdout.trim().split(/\s+/).at(-1) ?? "");

      try {
        await exec("npm", ["init", "-y"], { cwd: dir });
        await exec("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--silent", tarball], { cwd: dir });

        const moryn = join(dir, "node_modules", ".bin", "moryn");
        await exec(moryn, ["--store", store, "init"], { cwd: dir });
        await exec(moryn, ["project", "init", "--path", project, "--project-id", "moryn", "--default-skill", "release"], { cwd: dir });
        await exec(moryn, [
          "--store", store,
          "write",
          "--kind", "skill",
          "--type", "procedure",
          "--scope", "global",
          "--tag", "release",
          "--state", "canonical",
          "--text", "Release from packed CLI",
          "--confirm"
        ], { cwd: dir });
        const decision = await exec(moryn, [
          "--store", store,
          "write",
          "--kind", "memory",
          "--type", "decision",
          "--scope", "project",
          "--project", project,
          "--state", "canonical",
          "--text", "Packed CLI can write memory"
        ], { cwd: dir });

        const recordId = (JSON.parse(decision.stdout) as { record: { id: string } }).record.id;
        const boot = await exec(moryn, ["--store", store, "boot", "--project", project], { cwd: dir });
        const recall = await exec(moryn, ["--store", store, "recall", "--record-id", recordId, "--project", project], { cwd: dir });
        const contracts = await exec(moryn, ["contracts", "selection-sources"], { cwd: dir });
        const operations = await exec(moryn, ["contracts", "operations"], { cwd: dir });
        const importCheck = await exec("node", [
          "--input-type=module",
          "-e",
          "import { BOOT_SELECTION_SOURCES, GUIDE_SELECTION_SOURCES, NEXT_ACTION_SELECTION_SOURCES, OPERATION_CONTRACTS_SELECTION_SOURCES, SELECTION_SOURCE_CONTRACTS, SELECTION_SOURCE_CONTRACTS_SELECTION_SOURCES, getOperationContracts, getSelectionSourceContracts, STORE_INIT_SELECTION_SOURCES, SYNC_RESULT_SELECTION_SOURCES } from '@richardyu114/moryn'; const selectionResponse = getSelectionSourceContracts(); const operationResponse = getOperationContracts(); console.log(`${STORE_INIT_SELECTION_SOURCES.config_file}|${BOOT_SELECTION_SOURCES.skill}|${SYNC_RESULT_SELECTION_SOURCES.pushed}|${GUIDE_SELECTION_SOURCES.guardrail}|${NEXT_ACTION_SELECTION_SOURCES.error_next_action}|${NEXT_ACTION_SELECTION_SOURCES.error_argument}|${SELECTION_SOURCE_CONTRACTS.lifecycle.guide.guardrail}|${SELECTION_SOURCE_CONTRACTS.sync.result.pushed}|${SELECTION_SOURCE_CONTRACTS_SELECTION_SOURCES.contract}|${selectionResponse.contracts.setup.store_init.config_file}|${selectionResponse.selection_sources.field}|${OPERATION_CONTRACTS_SELECTION_SOURCES.operation}|${OPERATION_CONTRACTS_SELECTION_SOURCES.allowed_value}|${OPERATION_CONTRACTS_SELECTION_SOURCES.argument}|${operationResponse.operations_by_id.agent_enter.interfaces.mcp.tool}|${operationResponse.operations_by_id.operation_contracts.interfaces.cli.command}|${operationResponse.operations_by_id.write.arguments_by_name.kind.allowed_values.join(',')}`);"
        ], { cwd: dir });
        const parsedContracts = JSON.parse(contracts.stdout) as {
          contracts: {
            setup: { store_init: { config_file: string } };
            lifecycle: { guide: { guardrail: string } };
          };
          selection_sources: { contract: string };
        };
        const parsedOperations = JSON.parse(operations.stdout) as {
          recommended_entrypoint: string;
          operations_by_id: {
            agent_enter: { interfaces: { cli: { command: string } } };
            agent_finish: {
              argument_sources?: Record<string, string>;
              required_fields_by_name: { summary: { placeholder?: string } };
            };
            write: { required_fields_by_name: { kind: { allowed_values?: string[] } }; arguments_by_name: { kind: { allowed_values?: string[] } } };
            promote: { required_fields_by_name: { target_state: { allowed_values?: string[] } } };
            operation_contracts: { interfaces: { mcp: { tool: string } } };
          };
        };

        expect(boot.stdout).toContain("Release from packed CLI");
        expect(recall.stdout).toContain("Packed CLI can write memory");
        expect(parsedContracts.contracts.setup.store_init.config_file).toBe("artifacts.config");
        expect(parsedContracts.contracts.lifecycle.guide.guardrail).toBe("guardrails_by_id.<guardrail_id>");
        expect(parsedContracts.selection_sources.contract).toBe("contracts.<group>.<contract>");
        expect(parsedOperations.recommended_entrypoint).toBe("agent_enter");
        expect(parsedOperations.operations_by_id.agent_enter.interfaces.cli.command).toBe("moryn agent enter");
        expect(parsedOperations.operations_by_id.agent_finish.required_fields_by_name.summary.placeholder).toBe("<summary>");
        expect(parsedOperations.operations_by_id.agent_finish.argument_sources?.summary).toBe("user_input.summary");
        expect(parsedOperations.operations_by_id.write.required_fields_by_name.kind.allowed_values).toEqual(["memory", "skill", "soul", "session_summary", "agent_note"]);
        expect(parsedOperations.operations_by_id.write.arguments_by_name.kind.allowed_values).toEqual(["memory", "skill", "soul", "session_summary", "agent_note"]);
        expect(parsedOperations.operations_by_id.promote.required_fields_by_name.target_state.allowed_values).toEqual(["raw", "candidate", "canonical", "archived", "quarantined"]);
        expect(parsedOperations.operations_by_id.operation_contracts.interfaces.mcp.tool).toBe("operation_contracts");
        expect(importCheck.stdout.trim()).toBe("artifacts.config|skills_by_id.<record_id>|pushed|guardrails_by_id.<guardrail_id>|error.next_action|error.next_action.arguments_by_name.<argument>|guardrails_by_id.<guardrail_id>|pushed|contracts.<group>.<contract>|artifacts.config|contracts.<group>.<contract>.<field>|operations_by_id.<operation>|operations_by_id.<operation>.required_fields_by_name.<field>.allowed_values[]|operations_by_id.<operation>.arguments_by_name.<argument>|agent_enter|moryn contracts operations|memory,skill,soul,session_summary,agent_note");
        expect(JSON.parse(await readFile(join(store, "config.json"), "utf8"))).toMatchObject({ store_version: 1 });
      } finally {
        if (tarball) {
          await rm(tarball, { force: true });
        }
      }
    });
  }, 120000);

  it("installs the packed package and runs the lifecycle smoke without dev dependencies", async () => {
    await withTempDir(async (dir) => {
      const pack = await exec("npm", ["pack", "--silent"], { cwd: process.cwd() });
      const tarball = join(process.cwd(), pack.stdout.trim().split(/\s+/).at(-1) ?? "");

      try {
        await exec("npm", ["init", "-y"], { cwd: dir });
        await exec("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--silent", tarball], { cwd: dir });

        const smoke = join(dir, "node_modules", ".bin", "moryn-agent-smoke");
        const result = await exec(smoke, [], { cwd: dir });

        expect(result.stdout).toContain("agent lifecycle smoke passed");
        expect(result.stdout).toContain("Codex smoke status reached Gemini");
        expect(result.stdout).toContain("Gemini smoke finish reached Codex");
      } finally {
        if (tarball) {
          await rm(tarball, { force: true });
        }
      }
    });
  }, 120000);
});
