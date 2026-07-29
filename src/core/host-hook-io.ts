import type { Readable } from "node:stream";
import { isOperationDeadlineExceeded, OperationDeadlineExceededError } from "./operation-deadline.js";

export class HostHookInputLimitError extends Error {
  constructor(limitBytes: number) {
    super(`Invalid argument: host hook input exceeds ${limitBytes} bytes`);
    this.name = "HostHookInputLimitError";
  }
}

function deadlineError(signal: AbortSignal): OperationDeadlineExceededError {
  return isOperationDeadlineExceeded(signal.reason) ? signal.reason : new OperationDeadlineExceededError();
}

export function assertHostHookInputLimit(raw: string, limitBytes: number): void {
  if (Buffer.byteLength(raw) > limitBytes) throw new HostHookInputLimitError(limitBytes);
}

/**
 * Reads one official hook payload without retaining unbounded stdin. Aborting
 * destroys this process-local input stream so an upstream writer cannot keep
 * the CLI alive after the operation deadline.
 */
export function readHostHookInput(
  stream: Readable,
  signal: AbortSignal | undefined,
  limitBytes: number
): Promise<string> {
  if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) {
    throw new Error("Invalid argument: host hook input limit must be a positive safe integer");
  }
  if (signal?.aborted) return Promise.reject(deadlineError(signal));
  if (stream.readableEnded) return Promise.resolve("");

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;

    const cleanup = () => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      stream.off("aborted", onAborted);
      stream.off("close", onClose);
      signal?.removeEventListener("abort", onDeadline);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const stopInput = () => {
      stream.pause();
      stream.destroy();
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > limitBytes) {
        finish(new HostHookInputLimitError(limitBytes));
        stopInput();
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => finish();
    const onError = (error: Error) => finish(error);
    const onAborted = () => finish(new Error("Host hook input aborted before completion"));
    const onClose = () => {
      if (!stream.readableEnded) finish(new Error("Host hook input closed before completion"));
    };
    const onDeadline = () => {
      finish(deadlineError(signal!));
      stopInput();
    };

    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
    stream.once("aborted", onAborted);
    stream.once("close", onClose);
    signal?.addEventListener("abort", onDeadline, { once: true });
    stream.resume();
  });
}
