import { createInterface } from "node:readline/promises";
import type { createEngine } from "../core/engine.js";

type Engine = ReturnType<typeof createEngine>;

interface RpcRequest {
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

export async function runMcpServer(engine: Engine): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const request = JSON.parse(line) as RpcRequest;
    try {
      let result: unknown;
      if (request.method === "boot") result = await engine.boot({ project_id: request.params?.project_id as string | undefined });
      else if (request.method === "recall") result = await engine.recall(request.params ?? {});
      else if (request.method === "list_recent") result = await engine.listRecent(Number(request.params?.limit ?? 20));
      else throw new Error(`Unknown method: ${request.method}`);
      process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stdout.write(`${JSON.stringify({ id: request.id, error: { message } })}\n`);
    }
  }
}
