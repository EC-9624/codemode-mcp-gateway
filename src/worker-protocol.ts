import { type SandboxResult } from "./sandbox-result";
import { type SerializedToolResult } from "./tool";

type DecodeResult<T> = { ok: true; value: T } | { ok: false; message: string };

export type WorkerRequest = { type: "execute"; code: string; toolNames: string[] };

export const WorkerRequest = {
  decode(value: unknown): DecodeResult<WorkerRequest> {
    if (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "execute" &&
      "code" in value &&
      typeof value.code === "string" &&
      "toolNames" in value &&
      isToolNames(value.toolNames)
    ) {
      return { ok: true, value: { type: "execute", code: value.code, toolNames: value.toolNames } };
    }
    return { ok: false, message: "Sandbox worker received an invalid execution request." };
  },
};

export type WorkerResponse =
  | { type: "tool-call"; callId: number; name: string; argsJson: string | undefined }
  | { type: "completed"; result: SandboxResult }
  | { type: "failed"; reason: "request" | "execution" };

export const WorkerResponse = {
  decode(value: unknown): DecodeResult<WorkerResponse> {
    if (typeof value === "object" && value !== null && "type" in value) {
      if (
        value.type === "tool-call" &&
        "callId" in value &&
        isCallId(value.callId) &&
        "name" in value &&
        typeof value.name === "string" &&
        "argsJson" in value &&
        isJsonText(value.argsJson)
      ) {
        return {
          ok: true,
          value: {
            type: "tool-call",
            callId: value.callId,
            name: value.name,
            argsJson: value.argsJson,
          },
        };
      }
      if (
        value.type === "failed" &&
        "reason" in value &&
        (value.reason === "request" || value.reason === "execution")
      ) {
        return { ok: true, value: { type: "failed", reason: value.reason } };
      }
      if (value.type === "completed" && "result" in value && isSandboxResult(value.result)) {
        return { ok: true, value: { type: "completed", result: value.result } };
      }
    }
    return { ok: false, message: "Sandbox worker returned an invalid response." };
  },
};

export type ToolReply = { type: "tool-result"; callId: number; result: SerializedToolResult };

export const ToolReply = {
  decode(value: unknown): DecodeResult<ToolReply> {
    if (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "tool-result" &&
      "callId" in value &&
      isCallId(value.callId) &&
      "result" in value &&
      isSerializedToolResult(value.result)
    ) {
      return {
        ok: true,
        value: { type: "tool-result", callId: value.callId, result: value.result },
      };
    }
    return { ok: false, message: "Sandbox worker received an invalid tool reply." };
  },
};

function isCallId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isToolNames(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    Array.from(value).every((name: unknown) => typeof name === "string") &&
    new Set(value).size === value.length
  );
}

function isJsonText(value: unknown): value is string | undefined {
  if (value === undefined) return true;
  if (typeof value !== "string") return false;
  try {
    JSON.parse(value);
    return true;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return false;
  }
}

function isSerializedToolResult(value: unknown): value is SerializedToolResult {
  if (typeof value !== "object" || value === null || !("ok" in value)) return false;
  if (value.ok === true) return "json" in value && isJsonText(value.json);
  return (
    value.ok === false &&
    "error" in value &&
    typeof value.error === "object" &&
    value.error !== null &&
    "message" in value.error &&
    typeof value.error.message === "string"
  );
}

function isSandboxResult(value: unknown): value is SandboxResult {
  if (typeof value !== "object" || value === null || !("ok" in value)) return false;
  // The engine already performs JSON conversion; the generic result remains unknown.
  if (value.ok === true) return "value" in value;
  if (value.ok !== false || !("error" in value)) return false;
  const error = value.error;
  return (
    typeof error === "object" &&
    error !== null &&
    "kind" in error &&
    (error.kind === "script" || error.kind === "timeout") &&
    "message" in error &&
    typeof error.message === "string"
  );
}
