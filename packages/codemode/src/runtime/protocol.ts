import { type SandboxResult } from "../types.ts";
import { type SerializedToolResult } from "../tools.ts";
import { findInvalidLimit, isPositiveInt, type ExecutionLimits } from "./limits.ts";

type DecodeResult<T> = { ok: true; value: T } | { ok: false; message: string };

/** JSON envelopes use null for absent JSON text, distinct from the text "null". */
export type GuestCall = {
  type: "call";
  callId: number;
  name: string;
  argsJson: string | null;
};

export const GuestCall = {
  decode(json: unknown): DecodeResult<GuestCall> {
    const decoded = parseJsonText(json);
    if (!decoded.ok || !isRecord(decoded.value)) return invalidGuestCall();

    const call = decoded.value;
    if (
      call.type !== "call" ||
      !isCallId(call.callId) ||
      typeof call.name !== "string" ||
      (call.argsJson !== null &&
        (typeof call.argsJson !== "string" || !parseJsonText(call.argsJson).ok))
    ) {
      return invalidGuestCall();
    }

    return {
      ok: true,
      value: { type: "call", callId: call.callId, name: call.name, argsJson: call.argsJson },
    };
  },
};

export type GuestReply = {
  type: "result";
  callId: number;
  result: { ok: true; json: string | null } | { ok: false; error: { message: string } };
};

export const GuestReply = {
  encode(reply: ToolReply): string {
    return JSON.stringify({
      type: "result",
      callId: reply.callId,
      result: reply.result.ok
        ? { ok: true, json: reply.result.json ?? null }
        : { ok: false, error: { message: reply.result.error.message } },
    } satisfies GuestReply);
  },
};

function invalidGuestCall(): DecodeResult<never> {
  return { ok: false, message: "Sandbox guest sent an invalid tool call." };
}

/** Cancellation and source admission limits are classified by the parent, never the worker. */
export type GuestResult = Exclude<
  SandboxResult,
  { error: { kind: "cancelled" } } | { error: { resource: "source" } }
>;

export type WorkerStartupData = {
  type: "execute";
  code: string;
  toolNames: string[];
  limits: ExecutionLimits;
  interruptBuffer: SharedArrayBuffer;
};

export const WorkerStartupData = {
  decode(value: unknown): DecodeResult<WorkerStartupData> {
    if (
      isRecord(value) &&
      value.type === "execute" &&
      typeof value.code === "string" &&
      isToolNames(value.toolNames) &&
      isExecutionLimits(value.limits) &&
      value.interruptBuffer instanceof SharedArrayBuffer &&
      value.interruptBuffer.byteLength === Int32Array.BYTES_PER_ELEMENT
    ) {
      return {
        ok: true,
        value: {
          type: "execute",
          code: value.code,
          toolNames: value.toolNames,
          limits: value.limits,
          interruptBuffer: value.interruptBuffer,
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

function isExecutionLimits(value: unknown): value is ExecutionLimits {
  return isRecord(value) && findInvalidLimit(value) === undefined;
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

  if (value.ok !== false || !isRecord(value.error) || typeof value.error.message !== "string")
    return false;

  if (value.error.kind === "limit") {
    return (
      (value.error.resource === "output" ||
        value.error.resource === "tool-calls" ||
        value.error.resource === "concurrent-tool-calls") &&
      isPositiveInt(value.error.maximum)
    );
  }

  return value.error.kind === "script" || value.error.kind === "timeout";
}
