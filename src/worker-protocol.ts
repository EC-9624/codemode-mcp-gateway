import { type SandboxResult } from "./sandbox";

export type WorkerRequest = { type: "execute"; code: string };

export const WorkerRequest = {
  is(value: unknown): value is WorkerRequest {
    return (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "execute" &&
      "code" in value &&
      typeof value.code === "string"
    );
  },
};

export type WorkerResponse =
  | { type: "completed"; result: SandboxResult }
  | { type: "failed"; reason: "request" | "execution" };

export const WorkerResponse = {
  is(value: unknown): value is WorkerResponse {
    if (typeof value !== "object" || value === null || !("type" in value)) return false;
    if (value.type === "failed") {
      return "reason" in value && (value.reason === "request" || value.reason === "execution");
    }
    return value.type === "completed" && "result" in value && isSandboxResult(value.result);
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
