import { type GuestResult } from "./sandbox-result";
import { type SerializedToolResult } from "./tool";

type DecodeResult<T> = { ok: true; value: T } | { ok: false; message: string };

/** Longer delays overflow host timers, which then fire immediately. */
export const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export function isTimeoutMs(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value > 0 && value <= MAX_TIMEOUT_MS
  );
}

export type WorkerStartupData = {
  type: "execute";
  code: string;
  toolNames: string[];
  timeoutMs: number;
  interruptBuffer?: SharedArrayBuffer;
};

export const WorkerStartupData = {
  decode(value: unknown): DecodeResult<WorkerStartupData> {
    if (
      isRecord(value) &&
      value.type === "execute" &&
      typeof value.code === "string" &&
      isToolNames(value.toolNames) &&
      isTimeoutMs(value.timeoutMs) &&
      (value.interruptBuffer === undefined ||
        (value.interruptBuffer instanceof SharedArrayBuffer &&
          value.interruptBuffer.byteLength === Int32Array.BYTES_PER_ELEMENT))
    ) {
      return {
        ok: true,
        value: {
          type: "execute",
          code: value.code,
          toolNames: value.toolNames,
          timeoutMs: value.timeoutMs,
          ...(value.interruptBuffer === undefined
            ? {}
            : { interruptBuffer: value.interruptBuffer }),
        },
      };
    }

    return { ok: false, message: "Sandbox worker received an invalid execution request." };
  },
};

/** Messages as the worker posts them. */
export type WorkerToMainMessage =
  | { type: "tool-call"; callId: number; name: string; argsJson: string | undefined }
  | { type: "completed"; result: GuestResult }
  | { type: "failed"; reason: "request" | "execution" };

/** Decoding parses tool arguments once, so dispatch receives data rather than JSON text. */
export type DecodedWorkerMessage =
  | { type: "tool-call"; callId: number; name: string; args: unknown }
  | Exclude<WorkerToMainMessage, { type: "tool-call" }>;

export const WorkerToMainMessage = {
  decode(value: unknown): DecodeResult<DecodedWorkerMessage> {
    if (!isRecord(value)) return invalidResponse();

    if (
      value.type === "tool-call" &&
      isCallId(value.callId) &&
      typeof value.name === "string" &&
      // Presence matters: a missing field is malformed, while undefined means no arguments.
      "argsJson" in value
    ) {
      const args = parseJsonText(value.argsJson);
      if (!args.ok) return invalidResponse();

      return {
        ok: true,
        value: { type: "tool-call", callId: value.callId, name: value.name, args: args.value },
      };
    }

    if (value.type === "failed" && (value.reason === "request" || value.reason === "execution")) {
      return { ok: true, value: { type: "failed", reason: value.reason } };
    }

    if (value.type === "completed" && isGuestResult(value.result)) {
      return { ok: true, value: { type: "completed", result: value.result } };
    }

    return invalidResponse();
  },
};

export type ToolReply = { type: "tool-result"; callId: number; result: SerializedToolResult };

export const ToolReply = {
  decode(value: unknown): DecodeResult<ToolReply> {
    if (
      isRecord(value) &&
      value.type === "tool-result" &&
      isCallId(value.callId) &&
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

function invalidResponse(): DecodeResult<never> {
  return { ok: false, message: "Sandbox worker returned an invalid response." };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

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

function parseJsonText(value: unknown): { ok: true; value: unknown } | { ok: false } {
  if (value === undefined) return { ok: true, value: undefined };

  if (typeof value !== "string") return { ok: false };

  try {
    const parsed: unknown = JSON.parse(value);

    return { ok: true, value: parsed };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;

    return { ok: false };
  }
}

function isSerializedToolResult(value: unknown): value is SerializedToolResult {
  if (!isRecord(value)) return false;

  // Results stay JSON text so the guest prelude, not the worker, builds guest values.
  if (value.ok === true) return "json" in value && parseJsonText(value.json).ok;

  return value.ok === false && isRecord(value.error) && typeof value.error.message === "string";
}

function isGuestResult(value: unknown): value is GuestResult {
  if (!isRecord(value)) return false;

  // The engine already performs JSON conversion; the generic result remains unknown.
  if (value.ok === true) return "value" in value;

  return (
    value.ok === false &&
    isRecord(value.error) &&
    (value.error.kind === "script" || value.error.kind === "timeout") &&
    typeof value.error.message === "string"
  );
}
