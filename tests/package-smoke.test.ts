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
          "import { BOOT_SELECTION_SOURCES, GUIDE_SELECTION_SOURCES, NEXT_ACTION_SELECTION_SOURCES, OPERATION_CONTRACTS_SELECTION_SOURCES, SELECTION_SOURCE_CONTRACTS, SELECTION_SOURCE_CONTRACTS_SELECTION_SOURCES, getOperationContracts, getSelectionSourceContracts, STORE_INIT_SELECTION_SOURCES, SYNC_RESULT_SELECTION_SOURCES } from '@richardyu114/moryn'; const selectionResponse = getSelectionSourceContracts(); const operationResponse = getOperationContracts(); const summaryCollect = operationResponse.operations_by_id.agent_finish.execution.required_inputs_by_field.summary.collect; console.log(`${STORE_INIT_SELECTION_SOURCES.config_file}|${BOOT_SELECTION_SOURCES.skill}|${SYNC_RESULT_SELECTION_SOURCES.pushed}|${GUIDE_SELECTION_SOURCES.guardrail}|${NEXT_ACTION_SELECTION_SOURCES.error_next_action}|${NEXT_ACTION_SELECTION_SOURCES.error_argument}|${SELECTION_SOURCE_CONTRACTS.lifecycle.guide.guardrail}|${SELECTION_SOURCE_CONTRACTS.sync.result.pushed}|${SELECTION_SOURCE_CONTRACTS_SELECTION_SOURCES.contract}|${selectionResponse.contracts.setup.store_init.config_file}|${selectionResponse.selection_sources.field}|${OPERATION_CONTRACTS_SELECTION_SOURCES.operation}|${OPERATION_CONTRACTS_SELECTION_SOURCES.mcp_tool_operation}|${OPERATION_CONTRACTS_SELECTION_SOURCES.cli_command_operation}|${OPERATION_CONTRACTS_SELECTION_SOURCES.allowed_value}|${OPERATION_CONTRACTS_SELECTION_SOURCES.required_input}|${OPERATION_CONTRACTS_SELECTION_SOURCES.required_input_argument_path}|${OPERATION_CONTRACTS_SELECTION_SOURCES.argument}|${OPERATION_CONTRACTS_SELECTION_SOURCES.cli_argv}|${OPERATION_CONTRACTS_SELECTION_SOURCES.cli_executable}|${OPERATION_CONTRACTS_SELECTION_SOURCES.cli_args}|${OPERATION_CONTRACTS_SELECTION_SOURCES.cli_exec_file}|${OPERATION_CONTRACTS_SELECTION_SOURCES.cli_placeholder}|${OPERATION_CONTRACTS_SELECTION_SOURCES.cli_command_line}|${operationResponse.operations_by_id.agent_enter.interfaces.mcp.tool}|${operationResponse.operations_by_mcp_tool.agent_enter.operation}|${operationResponse.operations_by_cli_command['moryn agent enter'].operation}|${operationResponse.operations_by_id.agent_enter.selection_sources.operation}|${operationResponse.operations_by_id.agent_enter.interfaces.cli.executable}|${operationResponse.operations_by_id.agent_enter.interfaces.cli.args.join(' ')}|${operationResponse.operations_by_id.agent_enter.interfaces.cli.exec_file.executable}|${operationResponse.operations_by_id.agent_enter.interfaces.cli.exec_file.args.join(' ')}|${operationResponse.operations_by_id.agent_enter.interfaces.cli.argv.join(' ')}|${operationResponse.operations_by_id.agent_enter.interfaces.cli.command_line}|${operationResponse.operations_by_id.operation_contracts.interfaces.cli.command}|${operationResponse.operations_by_id.operation_contracts.interfaces.cli.executable}|${operationResponse.operations_by_id.operation_contracts.interfaces.cli.args.join(' ')}|${operationResponse.operations_by_id.operation_contracts.interfaces.cli.exec_file.executable}|${operationResponse.operations_by_id.operation_contracts.interfaces.cli.exec_file.args.join(' ')}|${operationResponse.operations_by_id.operation_contracts.interfaces.cli.argv.join(' ')}|${operationResponse.operations_by_id.operation_contracts.interfaces.cli.command_line}|${operationResponse.operations_by_id.write.interfaces.cli.executable}|${operationResponse.operations_by_id.write.interfaces.cli.args.join(' ')}|${operationResponse.operations_by_id.write.interfaces.cli.exec_file.executable}|${operationResponse.operations_by_id.write.interfaces.cli.exec_file.args.join(' ')}|${operationResponse.operations_by_id.write.interfaces.cli.argv.join(' ')}|${operationResponse.operations_by_id.write.interfaces.cli.command_line}|${operationResponse.operations_by_id.write.arguments_by_name.kind.allowed_values.join(',')}|${operationResponse.operations_by_id.recall.execution.next_step}|${operationResponse.operations_by_id.agent_finish.execution.next_step}|${operationResponse.operations_by_id.agent_finish.execution.required_inputs[0].argument_source}|${operationResponse.operations_by_id.agent_finish.execution.required_inputs_by_field.summary.argument_source}|${operationResponse.operations_by_id.agent_finish.execution.required_inputs_by_field.summary.selection_sources.required_input}|${operationResponse.operations_by_id.agent_finish.execution.required_inputs_by_field.summary.selection_sources.required_input_argument_path}|${summaryCollect.prompt}|${summaryCollect.apply_to.mcp_targets[0].argument}|${summaryCollect.apply_to.cli_targets[0].flag}`);"
        ], { cwd: dir });
        const operationRequiredInputSources = {
          required_input: "operations_by_id.<operation>.execution.required_inputs_by_field.<field>",
          required_input_argument_path: "operations_by_id.<operation>.execution.required_inputs_by_argument_path.<argument_path>"
        };
        const parsedContracts = JSON.parse(contracts.stdout) as {
          contracts: {
            setup: { store_init: { config_file: string } };
            lifecycle: { guide: { guardrail: string } };
          };
          selection_sources: { contract: string };
        };
        const parsedOperations = JSON.parse(operations.stdout) as {
          recommended_entrypoint: string;
          operations_by_mcp_tool: {
            agent_enter: { operation: string };
            operation_contracts: { operation: string };
          };
          operations_by_cli_command: {
            "moryn agent enter": { operation: string };
            "moryn contracts operations": { operation: string };
          };
          operations_by_id: {
            agent_enter: { interfaces: { cli: { command: string; executable: string; argv: string[]; args: string[]; exec_file: { executable: string; args: string[] }; placeholders: string[]; has_placeholders: boolean; command_line: string } } };
            agent_finish: {
              argument_sources?: Record<string, string>;
              execution: {
                next_step: string;
                blocked_by: string[];
                missing_required_fields: string[];
                required_inputs: Array<{ field: string; argument_path: string; argument_paths: string[]; collect?: { source: string; input_key: string; prompt: string; apply_to: { mcp_argument_paths: string[]; mcp_targets?: Array<{ argument: string; type?: string; required?: boolean; preferred: boolean }>; cli_targets?: Array<{ flag?: string; positional?: string; type?: string; required?: boolean; repeatable?: boolean; default?: unknown; preferred: boolean }> }; value_path?: string; placeholder?: string }; argument_source?: string; selection_sources?: Record<string, string>; placeholder?: string; mcp_targets?: Array<{ argument: string; type?: string; required?: boolean; preferred: boolean }>; cli_targets?: Array<{ flag?: string; positional?: string; type?: string; required?: boolean; repeatable?: boolean; default?: unknown; preferred: boolean }> }>;
                required_inputs_by_field: Record<string, { field: string; argument_path: string; argument_paths: string[]; collect?: { source: string; input_key: string; prompt: string; apply_to: { mcp_argument_paths: string[]; mcp_targets?: Array<{ argument: string; type?: string; required?: boolean; preferred: boolean }>; cli_targets?: Array<{ flag?: string; positional?: string; type?: string; required?: boolean; repeatable?: boolean; default?: unknown; preferred: boolean }> }; value_path?: string; placeholder?: string }; argument_source?: string; selection_sources?: Record<string, string>; placeholder?: string; mcp_targets?: Array<{ argument: string; type?: string; required?: boolean; preferred: boolean }>; cli_targets?: Array<{ flag?: string; positional?: string; type?: string; required?: boolean; repeatable?: boolean; default?: unknown; preferred: boolean }> }>;
                required_inputs_by_argument_path: Record<string, { field: string; argument_path: string; argument_paths: string[]; argument_source?: string; selection_sources?: Record<string, string>; placeholder?: string; mcp_targets?: Array<{ argument: string; type?: string; required?: boolean; preferred: boolean }>; cli_targets?: Array<{ flag?: string; positional?: string; type?: string; required?: boolean; repeatable?: boolean; default?: unknown; preferred: boolean }> }>;
              };
              required_fields_by_name: { summary: { placeholder?: string } };
            };
            write: { interfaces: { cli: { executable: string; argv: string[]; args: string[]; exec_file: { executable: string; args: string[] }; placeholders: string[]; has_placeholders: boolean; command_line: string } }; selection_sources?: Record<string, string>; execution: { required_inputs: Array<{ field: string; argument_paths: string[]; collect?: { prompt: string; alternatives?: string[]; apply_to: { mcp_argument_paths: string[] } }; selection_sources?: Record<string, string>; mcp_targets?: Array<{ argument: string; type?: string; required?: boolean; preferred: boolean }>; cli_targets?: Array<{ flag?: string; positional?: string; type?: string; required?: boolean; repeatable?: boolean; default?: unknown; preferred: boolean }> }>; required_inputs_by_field: Record<string, { argument_paths: string[]; collect?: { prompt: string; alternatives?: string[]; apply_to: { mcp_argument_paths: string[] } }; selection_sources?: Record<string, string>; mcp_targets?: Array<{ argument: string; type?: string; required?: boolean; preferred: boolean }>; cli_targets?: Array<{ flag?: string; positional?: string; type?: string; required?: boolean; repeatable?: boolean; default?: unknown; preferred: boolean }> }>; required_inputs_by_argument_path: Record<string, { field: string; argument_paths: string[]; selection_sources?: Record<string, string> }> }; required_fields_by_name: { kind: { allowed_values?: string[] } }; arguments_by_name: { kind: { allowed_values?: string[] } } };
            recall: { execution: { next_step: string; blocked_by: string[]; ready_to_run: boolean; required_inputs: unknown[]; required_inputs_by_field: Record<string, unknown>; required_inputs_by_argument_path: Record<string, unknown> } };
            promote: { execution: { next_step: string; blocked_by: string[]; missing_required_fields: string[]; required_inputs: Array<{ field: string; argument_path: string; argument_paths: string[]; selection_sources?: Record<string, string>; allowed_values?: string[]; mcp_targets?: Array<{ argument: string; type?: string; required?: boolean; preferred: boolean }>; cli_targets?: Array<{ flag?: string; positional?: string; type?: string; required?: boolean; repeatable?: boolean; default?: unknown; preferred: boolean }> }>; required_inputs_by_field: Record<string, { field: string; argument_path: string; argument_paths: string[]; selection_sources?: Record<string, string>; allowed_values?: string[]; mcp_targets?: Array<{ argument: string; type?: string; required?: boolean; preferred: boolean }>; cli_targets?: Array<{ flag?: string; positional?: string; type?: string; required?: boolean; repeatable?: boolean; default?: unknown; preferred: boolean }> }>; required_inputs_by_argument_path: Record<string, { field: string; argument_path: string; argument_paths: string[]; selection_sources?: Record<string, string>; allowed_values?: string[] }> }; required_fields_by_name: { target_state: { allowed_values?: string[] } } };
            project_init: { execution: { next_step: string; blocked_by: string[]; missing_required_fields: string[]; required_inputs: Array<{ field: string; argument_source?: string; selection_sources?: Record<string, string>; mcp_targets?: Array<{ argument: string; type?: string; required?: boolean; preferred: boolean }>; cli_targets?: Array<{ flag?: string; positional?: string; type?: string; required?: boolean; repeatable?: boolean; default?: unknown; preferred: boolean }> }>; required_inputs_by_field: Record<string, { field: string; argument_source?: string; selection_sources?: Record<string, string>; mcp_targets?: Array<{ argument: string; type?: string; required?: boolean; preferred: boolean }>; cli_targets?: Array<{ flag?: string; positional?: string; type?: string; required?: boolean; repeatable?: boolean; default?: unknown; preferred: boolean }> }>; required_inputs_by_argument_path: Record<string, { field: string; argument_source?: string; selection_sources?: Record<string, string> }>; requires_user_confirmation: boolean } };
            operation_contracts: { interfaces: { cli: { executable: string; argv: string[]; args: string[]; exec_file: { executable: string; args: string[] }; placeholders: string[]; has_placeholders: boolean; command_line: string }; mcp: { tool: string } } };
          };
        };

        expect(boot.stdout).toContain("Release from packed CLI");
        expect(recall.stdout).toContain("Packed CLI can write memory");
        expect(parsedContracts.contracts.setup.store_init.config_file).toBe("artifacts.config");
        expect(parsedContracts.contracts.lifecycle.guide.guardrail).toBe("guardrails_by_id.<guardrail_id>");
        expect(parsedContracts.selection_sources.contract).toBe("contracts.<group>.<contract>");
        expect(parsedOperations.recommended_entrypoint).toBe("agent_enter");
        expect(parsedOperations.operations_by_mcp_tool.agent_enter.operation).toBe("agent_enter");
        expect(parsedOperations.operations_by_mcp_tool.operation_contracts.operation).toBe("operation_contracts");
        expect(parsedOperations.operations_by_cli_command["moryn agent enter"].operation).toBe("agent_enter");
        expect(parsedOperations.operations_by_cli_command["moryn contracts operations"].operation).toBe("operation_contracts");
        expect(parsedOperations.operations_by_id.agent_enter.interfaces.cli.command).toBe("moryn agent enter");
        expect(parsedOperations.operations_by_id.agent_enter.interfaces.cli.executable).toBe("moryn");
        expect(parsedOperations.operations_by_id.agent_enter.interfaces.cli.argv).toEqual(["agent", "enter"]);
        expect(parsedOperations.operations_by_id.agent_enter.interfaces.cli.args).toEqual(["agent", "enter"]);
        expect(parsedOperations.operations_by_id.agent_enter.interfaces.cli.exec_file).toEqual({
          executable: "moryn",
          args: ["agent", "enter"]
        });
        expect(parsedOperations.operations_by_id.agent_enter.interfaces.cli.placeholders).toEqual([]);
        expect(parsedOperations.operations_by_id.agent_enter.interfaces.cli.has_placeholders).toBe(false);
        expect(parsedOperations.operations_by_id.agent_enter.interfaces.cli.command_line).toBe("moryn agent enter");
        expect(parsedOperations.operations_by_id.operation_contracts.interfaces.cli.executable).toBe("moryn");
        expect(parsedOperations.operations_by_id.operation_contracts.interfaces.cli.argv).toEqual(["contracts", "operations"]);
        expect(parsedOperations.operations_by_id.operation_contracts.interfaces.cli.args).toEqual(["contracts", "operations"]);
        expect(parsedOperations.operations_by_id.operation_contracts.interfaces.cli.exec_file).toEqual({
          executable: "moryn",
          args: ["contracts", "operations"]
        });
        expect(parsedOperations.operations_by_id.operation_contracts.interfaces.cli.placeholders).toEqual([]);
        expect(parsedOperations.operations_by_id.operation_contracts.interfaces.cli.has_placeholders).toBe(false);
        expect(parsedOperations.operations_by_id.operation_contracts.interfaces.cli.command_line).toBe("moryn contracts operations");
        expect(parsedOperations.operations_by_id.write.interfaces.cli.executable).toBe("moryn");
        expect(parsedOperations.operations_by_id.write.interfaces.cli.argv).toEqual([
          "write", "--kind", "<kind>", "--type", "<type>", "--scope", "<scope>", "--text", "<text>"
        ]);
        expect(parsedOperations.operations_by_id.write.interfaces.cli.args).toEqual([
          "write", "--kind", "<kind>", "--type", "<type>", "--scope", "<scope>", "--text", "<text>"
        ]);
        expect(parsedOperations.operations_by_id.write.interfaces.cli.exec_file).toEqual({
          executable: "moryn",
          args: ["write", "--kind", "<kind>", "--type", "<type>", "--scope", "<scope>", "--text", "<text>"]
        });
        expect(parsedOperations.operations_by_id.write.interfaces.cli.placeholders).toEqual(["kind", "type", "scope", "text"]);
        expect(parsedOperations.operations_by_id.write.interfaces.cli.has_placeholders).toBe(true);
        expect(parsedOperations.operations_by_id.write.interfaces.cli.command_line).toBe("moryn write --kind '<kind>' --type '<type>' --scope '<scope>' --text '<text>'");
        expect(parsedOperations.operations_by_id.write.selection_sources).toEqual({
          operation: "operations_by_id.<operation>",
          operation_id: "operations_by_id.<operation>.operation",
          category: "operations_by_category.<category>",
          category_operation: "operations_by_category.<category>.<operation>",
          mcp_tool_operation: "operations_by_mcp_tool.<tool>",
          cli_command_operation: "operations_by_cli_command.<command>",
          required_field: "operations_by_id.<operation>.required_fields_by_name.<field>",
          allowed_value: "operations_by_id.<operation>.required_fields_by_name.<field>.allowed_values[]",
          required_input: "operations_by_id.<operation>.execution.required_inputs_by_field.<field>",
          required_input_argument_path: "operations_by_id.<operation>.execution.required_inputs_by_argument_path.<argument_path>",
          argument: "operations_by_id.<operation>.arguments_by_name.<argument>",
          argument_allowed_value: "operations_by_id.<operation>.arguments_by_name.<argument>.allowed_values[]",
          argument_source: "operations_by_id.<operation>.argument_sources.<field>",
          cli_command: "operations_by_id.<operation>.interfaces.cli.command",
          cli_argv: "operations_by_id.<operation>.interfaces.cli.argv[]",
          cli_executable: "operations_by_id.<operation>.interfaces.cli.executable",
          cli_args: "operations_by_id.<operation>.interfaces.cli.args[]",
          cli_exec_file: "operations_by_id.<operation>.interfaces.cli.exec_file",
          cli_placeholder: "operations_by_id.<operation>.interfaces.cli.placeholders[]",
          cli_command_line: "operations_by_id.<operation>.interfaces.cli.command_line",
          mcp_tool: "operations_by_id.<operation>.interfaces.mcp.tool",
          ordered_operation: "operations[]"
        });
        expect(parsedOperations.operations_by_id.recall.execution).toMatchObject({
          next_step: "run",
          ready_to_run: true,
          blocked_by: [],
          required_inputs: [],
          required_inputs_by_field: {},
          required_inputs_by_argument_path: {},
          runbook: {
            next: "call_mcp",
            steps: [expect.objectContaining({ step: "call_mcp" })]
          }
        });
        expect(parsedOperations.operations_by_id.agent_finish.required_fields_by_name.summary.placeholder).toBe("<summary>");
        expect(parsedOperations.operations_by_id.agent_finish.argument_sources?.summary).toBe("user_input.summary");
        expect(parsedOperations.operations_by_id.agent_finish.execution).toMatchObject({
          next_step: "collect_required_fields",
          blocked_by: ["required_fields"],
          missing_required_fields: ["summary"],
          runbook: {
            next: "collect_required_inputs",
            steps: [
              expect.objectContaining({ step: "collect_required_inputs" }),
              expect.objectContaining({ step: "call_mcp" })
            ]
          },
          required_inputs: [{
            field: "summary",
            argument_path: "summary",
            argument_paths: ["summary"],
            argument_source: "user_input.summary",
            selection_sources: operationRequiredInputSources,
            placeholder: "<summary>",
            collect: {
              source: "user",
              input_key: "summary",
              prompt: "Provide summary.",
              apply_to: {
                mcp_argument_paths: ["summary"],
                mcp_targets: [{
                  argument: "summary",
                  type: "string",
                  required: true,
                  preferred: true
                }],
                cli_targets: [{
                  flag: "--summary",
                  type: "string",
                  required: true,
                  preferred: true
                }]
              },
              value_path: "user_input.summary",
              placeholder: "<summary>"
            },
            mcp_targets: [{
              argument: "summary",
              type: "string",
              required: true,
              preferred: true
            }],
            cli_targets: [{
              flag: "--summary",
              type: "string",
              required: true,
              preferred: true
            }]
          }],
          required_inputs_by_field: {
            summary: {
              field: "summary",
              argument_path: "summary",
              argument_paths: ["summary"],
              argument_source: "user_input.summary",
              selection_sources: operationRequiredInputSources,
              placeholder: "<summary>",
              collect: {
                source: "user",
                input_key: "summary",
                prompt: "Provide summary.",
                apply_to: {
                  mcp_argument_paths: ["summary"],
                  mcp_targets: [{
                    argument: "summary",
                    type: "string",
                    required: true,
                    preferred: true
                  }],
                  cli_targets: [{
                    flag: "--summary",
                    type: "string",
                    required: true,
                    preferred: true
                  }]
                },
                value_path: "user_input.summary",
                placeholder: "<summary>"
              },
              mcp_targets: [{
                argument: "summary",
                type: "string",
                required: true,
                preferred: true
              }],
              cli_targets: [{
                flag: "--summary",
                type: "string",
                required: true,
                preferred: true
              }]
            }
          },
          required_inputs_by_argument_path: {
            summary: {
              field: "summary",
              argument_path: "summary",
              argument_paths: ["summary"],
              argument_source: "user_input.summary",
              selection_sources: operationRequiredInputSources,
              placeholder: "<summary>",
              mcp_targets: [{
                argument: "summary",
                type: "string",
                required: true,
                preferred: true
              }],
              cli_targets: [{
                flag: "--summary",
                type: "string",
                required: true,
                preferred: true
              }]
            }
          }
        });
        expect(parsedOperations.operations_by_id.write.required_fields_by_name.kind.allowed_values).toEqual(["memory", "skill", "soul", "session_summary", "agent_note"]);
        expect(parsedOperations.operations_by_id.write.execution.required_inputs.find((input) => input.field === "text_or_content")?.argument_paths).toEqual(["text", "content"]);
        expect(parsedOperations.operations_by_id.write.execution.required_inputs.find((input) => input.field === "text_or_content")?.selection_sources).toEqual(operationRequiredInputSources);
        expect(parsedOperations.operations_by_id.write.execution.required_inputs_by_field.text_or_content.argument_paths).toEqual(["text", "content"]);
        expect(parsedOperations.operations_by_id.write.execution.required_inputs_by_field.text_or_content.selection_sources).toEqual(operationRequiredInputSources);
        expect(parsedOperations.operations_by_id.write.execution.required_inputs_by_field.text_or_content.collect).toMatchObject({
          prompt: "Provide text or content.",
          input_mode: "choose_one",
          choices: [
            {
              option: "text",
              argument_path: "text",
              value_path: "user_input.text_or_content",
              preferred: true,
              expected_value: {
                value_path: "user_input.text_or_content",
                kind: "string",
                value_encoding: "string"
              },
              apply_to: {
                mcp_argument_paths: ["text"],
                cli_assignments: [{
                  flag: "--text",
                  value_path: "user_input.text_or_content",
                  argv_template: ["--text", "<user_input.text_or_content>"],
                  value_encoding: "string",
                  preferred: true
                }]
              }
            },
            {
              option: "content",
              argument_path: "content",
              value_path: "user_input.text_or_content",
              preferred: false,
              expected_value: {
                value_path: "user_input.text_or_content",
                kind: "json_object",
                value_encoding: "json"
              },
              apply_to: {
                mcp_argument_paths: ["content"],
                cli_assignments: [{
                  flag: "--content-json",
                  value_path: "user_input.text_or_content",
                  argv_template: ["--content-json", "<json:user_input.text_or_content>"],
                  value_encoding: "json",
                  preferred: false
                }]
              }
            }
          ],
          apply_to: {
            assignment_mode: "choose_one",
            mcp_argument_paths: ["text", "content"],
            mcp_assignments: [
              {
                argument: "text",
                value_path: "user_input.text_or_content",
                preferred: true
              },
              {
                argument: "content",
                value_path: "user_input.text_or_content",
                preferred: false
              }
            ],
            cli_assignments: [
              {
                flag: "--text",
                value_path: "user_input.text_or_content",
                argv_template: ["--text", "<user_input.text_or_content>"],
                value_encoding: "string",
                type: "string",
                required: false,
                preferred: true
              },
              {
                flag: "--content-json",
                value_path: "user_input.text_or_content",
                argv_template: ["--content-json", "<json:user_input.text_or_content>"],
                value_encoding: "json",
                type: "object",
                required: false,
                preferred: false
              }
            ]
          },
          alternatives: ["text", "content"]
        });
        expect(parsedOperations.operations_by_id.write.execution.required_inputs_by_argument_path.text.argument_paths).toEqual(["text", "content"]);
        expect(parsedOperations.operations_by_id.write.execution.required_inputs_by_argument_path.text.selection_sources).toEqual(operationRequiredInputSources);
        expect(parsedOperations.operations_by_id.write.execution.required_inputs_by_argument_path.content).toEqual(parsedOperations.operations_by_id.write.execution.required_inputs_by_argument_path.text);
        expect(parsedOperations.operations_by_id.write.execution.required_inputs_by_field.text_or_content.mcp_targets).toEqual([
          {
            argument: "text",
            type: "string",
            required: false,
            preferred: true
          },
          {
            argument: "content",
            type: "object",
            required: false,
            preferred: false
          }
        ]);
        expect(parsedOperations.operations_by_id.write.execution.required_inputs_by_field.text_or_content.cli_targets).toEqual([
          {
            flag: "--text",
            type: "string",
            required: false,
            preferred: true
          },
          {
            flag: "--content-json",
            type: "object",
            required: false,
            preferred: false
          }
        ]);
        expect(parsedOperations.operations_by_id.write.arguments_by_name.kind.allowed_values).toEqual(["memory", "skill", "soul", "session_summary", "agent_note"]);
        expect(parsedOperations.operations_by_id.promote.required_fields_by_name.target_state.allowed_values).toEqual(["raw", "candidate", "canonical", "archived", "quarantined"]);
        expect(parsedOperations.operations_by_id.promote.execution.required_inputs.map((input) => input.selection_sources)).toEqual([
          operationRequiredInputSources,
          operationRequiredInputSources
        ]);
        expect(parsedOperations.operations_by_id.promote.execution.required_inputs_by_field.record_id.selection_sources).toEqual(operationRequiredInputSources);
        expect(parsedOperations.operations_by_id.promote.execution.required_inputs_by_field.target_state.selection_sources).toEqual(operationRequiredInputSources);
        expect(parsedOperations.operations_by_id.promote.execution).toMatchObject({
          next_step: "collect_required_fields",
          blocked_by: ["required_fields"],
          missing_required_fields: ["record_id", "target_state"],
          required_inputs: [
            {
              field: "record_id",
              argument_path: "record_id",
              argument_paths: ["record_id"],
              mcp_targets: [{
                argument: "record_id",
                type: "string",
                required: true,
                preferred: true
              }],
              cli_targets: [{
                positional: "record-id",
                type: "string",
                required: true,
                preferred: true
              }]
            },
            {
              field: "target_state",
              argument_path: "target_state",
              argument_paths: ["target_state"],
              allowed_values: ["raw", "candidate", "canonical", "archived", "quarantined"],
              mcp_targets: [{
                argument: "target_state",
                type: "string",
                required: true,
                preferred: true
              }],
              cli_targets: [{
                flag: "--state",
                type: "string",
                required: true,
                preferred: true
              }]
            }
          ],
          required_inputs_by_field: {
            record_id: {
              field: "record_id",
              argument_path: "record_id",
              argument_paths: ["record_id"],
              mcp_targets: [{
                argument: "record_id",
                type: "string",
                required: true,
                preferred: true
              }],
              cli_targets: [{
                positional: "record-id",
                type: "string",
                required: true,
                preferred: true
              }]
            },
            target_state: {
              field: "target_state",
              argument_path: "target_state",
              argument_paths: ["target_state"],
              allowed_values: ["raw", "candidate", "canonical", "archived", "quarantined"],
              mcp_targets: [{
                argument: "target_state",
                type: "string",
                required: true,
                preferred: true
              }],
              cli_targets: [{
                flag: "--state",
                type: "string",
                required: true,
                preferred: true
              }]
            }
          }
        });
        expect(parsedOperations.operations_by_id.project_init.execution).toMatchObject({
          next_step: "collect_required_fields",
          blocked_by: ["required_fields", "user_confirmation"],
          missing_required_fields: ["path"],
          required_inputs: [{
            field: "path",
            argument_source: "user_input.path",
            mcp_targets: [{
              argument: "path",
              type: "string",
              required: true,
              preferred: true
            }],
            cli_targets: [{
              flag: "--path",
              type: "string",
              required: true,
              default: ".",
              preferred: true
            }]
          }],
          required_inputs_by_field: {
            path: {
              field: "path",
              argument_source: "user_input.path",
              mcp_targets: [{
                argument: "path",
                type: "string",
                required: true,
                preferred: true
              }],
              cli_targets: [{
                flag: "--path",
                type: "string",
                required: true,
                default: ".",
                preferred: true
              }]
            }
          },
          requires_user_confirmation: true
        });
        expect(parsedOperations.operations_by_id.project_init.execution.required_inputs[0]?.selection_sources).toEqual(operationRequiredInputSources);
        expect(parsedOperations.operations_by_id.project_init.execution.required_inputs_by_field.path.selection_sources).toEqual(operationRequiredInputSources);
        expect(parsedOperations.operations_by_id.project_init.execution.required_inputs_by_field.path.collect).toMatchObject({
          source: "user",
          input_key: "path",
          prompt: "Provide path.",
          value_path: "user_input.path"
        });
        expect(parsedOperations.operations_by_id.operation_contracts.interfaces.mcp.tool).toBe("operation_contracts");
        expect(importCheck.stdout.trim()).toBe("artifacts.config|skills_by_id.<record_id>|pushed|guardrails_by_id.<guardrail_id>|error.next_action|error.next_action.arguments_by_name.<argument>|guardrails_by_id.<guardrail_id>|pushed|contracts.<group>.<contract>|artifacts.config|contracts.<group>.<contract>.<field>|operations_by_id.<operation>|operations_by_mcp_tool.<tool>|operations_by_cli_command.<command>|operations_by_id.<operation>.required_fields_by_name.<field>.allowed_values[]|operations_by_id.<operation>.execution.required_inputs_by_field.<field>|operations_by_id.<operation>.execution.required_inputs_by_argument_path.<argument_path>|operations_by_id.<operation>.arguments_by_name.<argument>|operations_by_id.<operation>.interfaces.cli.argv[]|operations_by_id.<operation>.interfaces.cli.executable|operations_by_id.<operation>.interfaces.cli.args[]|operations_by_id.<operation>.interfaces.cli.exec_file|operations_by_id.<operation>.interfaces.cli.placeholders[]|operations_by_id.<operation>.interfaces.cli.command_line|agent_enter|agent_enter|agent_enter|operations_by_id.<operation>|moryn|agent enter|moryn|agent enter|agent enter|moryn agent enter|moryn contracts operations|moryn|contracts operations|moryn|contracts operations|contracts operations|moryn contracts operations|moryn|write --kind <kind> --type <type> --scope <scope> --text <text>|moryn|write --kind <kind> --type <type> --scope <scope> --text <text>|write --kind <kind> --type <type> --scope <scope> --text <text>|moryn write --kind '<kind>' --type '<type>' --scope '<scope>' --text '<text>'|memory,skill,soul,session_summary,agent_note|run|collect_required_fields|user_input.summary|user_input.summary|operations_by_id.<operation>.execution.required_inputs_by_field.<field>|operations_by_id.<operation>.execution.required_inputs_by_argument_path.<argument_path>|Provide summary.|summary|--summary");
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
