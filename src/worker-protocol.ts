import { type SandboxResult } from "./sandbox";

type DecodeResult<T> = { ok: true; value: T } | { ok: false; message: string };

export type WorkerRequest = { type: "execute"; code: string };

export const WorkerRequest = {
  decode(value: unknown): DecodeResult<WorkerRequest> {
    if (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "execute" &&
      "code" in value &&
      typeof value.code === "string"
    ) {
      return { ok: true, value: { type: "execute", code: value.code } };
    }
    return { ok: false, message: "Sandbox worker received an invalid execution request." };
  },
};

export type WorkerResponse =
  | { type: "completed"; result: SandboxResult }
  | { type: "failed"; reason: "request" | "execution" };

export const WorkerResponse = {
  decode(value: unknown): DecodeResult<WorkerResponse> {
    if (typeof value === "object" && value !== null && "type" in value) {
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
