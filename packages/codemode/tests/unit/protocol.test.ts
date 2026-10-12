import { describe, expect, test } from "bun:test";
import { ToolResult } from "@cmg/codemode";
import {
  ToolReply,
  GuestCall,
  GuestReply,
  WorkerStartupData,
  WorkerToMainMessage,
} from "../../src/runtime/protocol";
import { interruptFlag, startupData } from "../support/workers";

const request = startupData("return 42;");

describe("guest call envelopes", () => {
  test.each([
    ["absent arguments", null],
    ["JSON null", "null"],
    ["a string", '"before\\u0000after"'],
    ["an object", '{"value":42}'],
  ] as const)("preserves %s and exact tool names", (_name, argsJson) => {
    const call = { type: "call", callId: 1, name: "read\u0000\ud800", argsJson } as const;

    expect(GuestCall.decode(JSON.stringify(call))).toEqual({ ok: true, value: call });
  });

  test.each([
    ["missing text", undefined],
    ["a native object", {}],
    ["invalid JSON", "not JSON"],
    ["JSON null", "null"],
    ["an empty object", "{}"],
    ["an unknown tag", JSON.stringify({ type: "other", callId: 1, name: "read", argsJson: null })],
    ["a missing argument field", JSON.stringify({ type: "call", callId: 1, name: "read" })],
    [
      "non-JSON arguments",
      JSON.stringify({ type: "call", callId: 1, name: "read", argsJson: "bad" }),
    ],
    ["native arguments", JSON.stringify({ type: "call", callId: 1, name: "read", argsJson: {} })],
    ["a non-string name", JSON.stringify({ type: "call", callId: 1, name: 42, argsJson: null })],
    ["a zero ID", JSON.stringify({ type: "call", callId: 0, name: "read", argsJson: null })],
    [
      "an unsafe ID",
      JSON.stringify({ type: "call", callId: 2 ** 53, name: "read", argsJson: null }),
    ],
  ])("rejects %s", (_name, value) => {
    expect(GuestCall.decode(value)).toEqual({
      ok: false,
      message: "Sandbox guest sent an invalid tool call.",
    });
  });

  test("selects protocol fields instead of forwarding guest extensions", () => {
    const call = { type: "call", callId: 1, name: "read", argsJson: null } as const;

    expect(GuestCall.decode(JSON.stringify({ ...call, extension: "ignored" }))).toEqual({
      ok: true,
      value: call,
    });
  });
});

describe("guest reply envelopes", () => {
  test.each([
    ["undefined", undefined, null],
    ["JSON null", "null", "null"],
    ["a string", '"hello"', '"hello"'],
  ] as const)("encodes %s without losing its JSON distinction", (_name, json, encoded) => {
    const reply = GuestReply.encode({ type: "tool-result", callId: 1, result: { ok: true, json } });

    expect(JSON.parse(reply)).toEqual({
      type: "result",
      callId: 1,
      result: { ok: true, json: encoded },
    });
  });

  test("preserves complete public messages and omits private failure fields", () => {
    const result = {
      ok: false,
      error: { message: "before\u0000after\ud800", private: "not public" },
    } as const;

    const reply = GuestReply.encode({ type: "tool-result", callId: 1, result });

    expect(JSON.parse(reply)).toEqual({
      type: "result",
      callId: 1,
      result: { ok: false, error: { message: result.error.message } },
    });
    expect(reply).not.toContain("not public");
  });
});

describe("worker startup data", () => {
  test("validates execution requests", () => {
    expect(WorkerStartupData.decode(request)).toEqual({ ok: true, value: request });
    for (const value of [null, undefined, 42, [], {}, { type: "execute", code: 42 }]) {
      expect(WorkerStartupData.decode(value)).toEqual({
        ok: false,
        message: "Sandbox worker received an invalid execution request.",
      });
    }
  });

  test("requires a dense list of unique string tool names", () => {
    for (const toolNames of [undefined, null, [42], ["read", "read"], Array(1)]) {
      expect(WorkerStartupData.decode({ ...request, toolNames }).ok).toBe(false);
    }
  });

  test("shares the interrupt flag without copying its memory", () => {
    const decoded = WorkerStartupData.decode(request);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;

    expect(decoded.value.interruptBuffer).toBe(request.interruptBuffer);
  });

  test("requires an interrupt flag of one shared 32-bit word", () => {
    for (const interruptBuffer of [
      undefined,
      null,
      42,
      new ArrayBuffer(4),
      new SharedArrayBuffer(0),
      new SharedArrayBuffer(8),
      interruptFlag(),
    ]) {
      expect(WorkerStartupData.decode({ ...request, interruptBuffer }).ok).toBe(false);
    }
  });

  test("requires resolved limits", () => {
    for (const limits of [undefined, null, 42, {}]) {
      expect(WorkerStartupData.decode({ ...request, limits }).ok).toBe(false);
    }
  });

  test.each([
    ["missing field", { ...request.limits, maxSourceBytes: undefined }],
    ["overflowing timeout", { ...request.limits, timeoutMs: 2147483648 }],
    ["oversized stack", { ...request.limits, maxStackSizeBytes: 4194305 }],
  ] as const)("rejects resolved limits with %s", (_name, limits) => {
    expect(WorkerStartupData.decode({ ...request, limits }).ok).toBe(false);
  });
});

describe("worker messages", () => {
  test.each([
    ["a completed value", { type: "completed", result: { ok: true, value: null } }],
    [
      "a script error",
      { type: "completed", result: { ok: false, error: { kind: "script", message: "failed" } } },
    ],
    [
      "a timeout",
      { type: "completed", result: { ok: false, error: { kind: "timeout", message: "expired" } } },
    ],
    [
      "an output limit",
      {
        type: "completed",
        result: {
          ok: false,
          error: { kind: "limit", resource: "output", maximum: 1, message: "too large" },
        },
      },
    ],
    [
      "a tool-call limit",
      {
        type: "completed",
        result: {
          ok: false,
          error: { kind: "limit", resource: "tool-calls", maximum: 100, message: "exhausted" },
        },
      },
    ],
    [
      "a concurrent tool-call limit",
      {
        type: "completed",
        result: {
          ok: false,
          error: {
            kind: "limit",
            resource: "concurrent-tool-calls",
            maximum: 10,
            message: "exhausted",
          },
        },
      },
    ],
    ["an execution failure", { type: "failed", reason: "execution" }],
    ["a request failure", { type: "failed", reason: "request" }],
  ] satisfies [string, WorkerToMainMessage][])("accepts %s envelope", (_name, value) => {
    expect(WorkerToMainMessage.decode(value)).toEqual({ ok: true, value });
  });

  test.each([
    ["null", null],
    ["undefined", undefined],
    ["an empty object", {}],
    ["an unknown type", { type: "other" }],
    ["an unknown failure reason", { type: "failed", reason: "other" }],
    ["a null result", { type: "completed", result: null }],
    ["a success without a value", { type: "completed", result: { ok: true } }],
    ["a non-boolean ok flag", { type: "completed", result: { ok: "true", value: 42 } }],
    ["a null error", { type: "completed", result: { ok: false, error: null } }],
    [
      "an unknown error kind",
      { type: "completed", result: { ok: false, error: { kind: "other", message: "failed" } } },
    ],
    // Only the parent can classify caller cancellation.
    [
      "a worker-reported cancellation",
      {
        type: "completed",
        result: { ok: false, error: { kind: "cancelled", message: "cancelled" } },
      },
    ],
    [
      "a worker-reported source limit",
      {
        type: "completed",
        result: {
          ok: false,
          error: { kind: "limit", resource: "source", maximum: 1, message: "too large" },
        },
      },
    ],
    [
      "a non-string script message",
      { type: "completed", result: { ok: false, error: { kind: "script", message: 42 } } },
    ],
  ] as const)("rejects %s as an invalid response", (_name, value) => {
    expect(WorkerToMainMessage.decode(value)).toEqual({
      ok: false,
      message: "Sandbox worker returned an invalid response.",
    });
  });

  test.each([
    ["undefined", undefined, undefined],
    ["null", "null", null],
    ["string", '"hello"', "hello"],
    ["object", '{"value":42}', { value: 42 }],
  ] as const)(
    "decodes %s tool-call arguments from JSON text into data",
    (_name, argsJson, args) => {
      expect(
        WorkerToMainMessage.decode({ type: "tool-call", callId: 1, name: "read", argsJson }),
      ).toEqual({ ok: true, value: { type: "tool-call", callId: 1, name: "read", args } });
    },
  );

  test.each([
    ["an unknown resource", { kind: "limit", resource: "other", maximum: 1, message: "bad" }],
    ["a missing tool-call maximum", { kind: "limit", resource: "tool-calls", message: "bad" }],
    [
      "a zero tool-call maximum",
      { kind: "limit", resource: "tool-calls", maximum: 0, message: "bad" },
    ],
    [
      "a string concurrency maximum",
      { kind: "limit", resource: "concurrent-tool-calls", maximum: "10", message: "bad" },
    ],
    ["a non-string message", { kind: "limit", resource: "tool-calls", maximum: 1, message: 42 }],
    ["a missing output maximum", { kind: "limit", resource: "output", message: "bad" }],
    ["a zero output maximum", { kind: "limit", resource: "output", maximum: 0, message: "bad" }],
    [
      "an overflowing output maximum",
      { kind: "limit", resource: "output", maximum: 2 ** 31, message: "bad" },
    ],
    [
      "a string output maximum",
      { kind: "limit", resource: "output", maximum: "1", message: "bad" },
    ],
  ] as const)("rejects a limit result with %s", (_name, error) => {
    expect(WorkerToMainMessage.decode({ type: "completed", result: { ok: false, error } }).ok).toBe(
      false,
    );
  });

  test("rejects tool calls whose arguments field is missing", () => {
    expect(WorkerToMainMessage.decode({ type: "tool-call", callId: 1, name: "read" }).ok).toBe(
      false,
    );
  });
});

describe("tool replies", () => {
  test.each([
    ["undefined", undefined],
    ["null", "null"],
    ["string", '"hello"'],
    ["object", '{"value":42}'],
  ] as const)("preserves %s serialized result text after validation", (_name, json) => {
    const reply = { type: "tool-result", callId: 1, result: { ok: true, json } } as const;

    expect(ToolReply.decode(reply)).toEqual({ ok: true, value: reply });
  });

  test("accepts explicit tool failure messages", () => {
    const failure = {
      type: "tool-result",
      callId: 1,
      result: ToolResult.failure("Public failure"),
    } as const;

    expect(ToolReply.decode(failure)).toEqual({ ok: true, value: failure });
  });

  test.each([
    ["a null result", null],
    ["an empty result", {}],
    ["a success without a json field", { ok: true }],
    ["a non-string failure message", { ok: false, error: { message: 42 } }],
  ] as const)("rejects replies with %s", (_name, result) => {
    expect(ToolReply.decode({ type: "tool-result", callId: 1, result }).ok).toBe(false);
  });
});

describe("shared tool-call fields", () => {
  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["infinite", Infinity],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
    ["string", "1"],
  ] as const)("rejects %s call IDs in both directions", (_name, callId) => {
    expect(
      WorkerToMainMessage.decode({ type: "tool-call", callId, name: "read", argsJson: undefined })
        .ok,
    ).toBe(false);
    expect(
      ToolReply.decode({ type: "tool-result", callId, result: { ok: true, json: "42" } }).ok,
    ).toBe(false);
  });

  test.each([
    ["a number", 42],
    ["an object", {}],
    ['the text "undefined"', "undefined"],
    ["non-JSON text", "not JSON"],
  ] as const)("rejects %s as argument or result JSON", (_name, json) => {
    expect(
      WorkerToMainMessage.decode({ type: "tool-call", callId: 1, name: "read", argsJson: json }).ok,
    ).toBe(false);
    expect(
      ToolReply.decode({ type: "tool-result", callId: 1, result: { ok: true, json } }).ok,
    ).toBe(false);
  });
});
