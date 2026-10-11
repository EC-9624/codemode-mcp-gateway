import { describe, expect, test } from "bun:test";
import { ToolResult } from "../src/sandbox";
import { ToolReply, WorkerStartupData, WorkerToMainMessage } from "../src/worker-protocol";

const request = {
  type: "execute",
  code: "return 42;",
  toolNames: [],
  timeoutMs: 1000,
} satisfies WorkerStartupData;

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
    for (const toolNames of [null, [42], ["read", "read"], Array(1)]) {
      expect(WorkerStartupData.decode({ ...request, toolNames }).ok).toBe(false);
    }

    expect(
      WorkerStartupData.decode({ type: "execute", code: "return 42;", timeoutMs: 1000 }).ok,
    ).toBe(false);
  });

  test("requires a positive integer deadline within the host timer range", () => {
    for (const timeoutMs of [undefined, 0, -1, 1.5, NaN, Infinity, 2 ** 31, "1000"]) {
      expect(WorkerStartupData.decode({ ...request, timeoutMs }).ok).toBe(false);
    }

    expect(WorkerStartupData.decode({ ...request, timeoutMs: 2 ** 31 - 1 }).ok).toBe(true);
  });

  test("accepts an optional shared interrupt flag without copying its memory", () => {
    const interruptBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const decoded = WorkerStartupData.decode({ ...request, interruptBuffer });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;

    expect(decoded.value.interruptBuffer).toBe(interruptBuffer);
  });

  test("rejects interrupt flags that are not one shared 32-bit word", () => {
    for (const interruptBuffer of [
      null,
      42,
      new ArrayBuffer(4),
      new SharedArrayBuffer(0),
      new SharedArrayBuffer(8),
      new Int32Array(new SharedArrayBuffer(4)),
    ]) {
      expect(WorkerStartupData.decode({ ...request, interruptBuffer }).ok).toBe(false);
    }
  });
});

describe("worker messages", () => {
  test("validates completion and infrastructure failure envelopes", () => {
    for (const value of [
      { type: "completed", result: { ok: true, value: null } },
      { type: "completed", result: { ok: false, error: { kind: "script", message: "failed" } } },
      { type: "completed", result: { ok: false, error: { kind: "timeout", message: "expired" } } },
      { type: "failed", reason: "execution" },
      { type: "failed", reason: "request" },
    ] satisfies WorkerToMainMessage[]) {
      expect(WorkerToMainMessage.decode(value)).toEqual({ ok: true, value });
    }

    for (const value of [
      null,
      undefined,
      {},
      { type: "other" },
      { type: "failed", reason: "other" },
      { type: "completed", result: null },
      { type: "completed", result: { ok: true } },
      { type: "completed", result: { ok: "true", value: 42 } },
      { type: "completed", result: { ok: false, error: null } },
      { type: "completed", result: { ok: false, error: { kind: "other", message: "failed" } } },
      { type: "completed", result: { ok: false, error: { kind: "script", message: 42 } } },
    ]) {
      expect(WorkerToMainMessage.decode(value)).toEqual({
        ok: false,
        message: "Sandbox worker returned an invalid response.",
      });
    }
  });

  test("decodes tool-call JSON text and undefined arguments into data", () => {
    for (const [argsJson, args] of [
      [undefined, undefined],
      ["null", null],
      ['"hello"', "hello"],
      ['{"value":42}', { value: 42 }],
    ] as const) {
      expect(
        WorkerToMainMessage.decode({ type: "tool-call", callId: 1, name: "read", argsJson }),
      ).toEqual({ ok: true, value: { type: "tool-call", callId: 1, name: "read", args } });
    }
  });

  test("rejects tool calls whose arguments field is missing", () => {
    expect(WorkerToMainMessage.decode({ type: "tool-call", callId: 1, name: "read" }).ok).toBe(
      false,
    );
  });
});

describe("tool replies", () => {
  test("preserves serialized result text and undefined after validation", () => {
    for (const json of [undefined, "null", '"hello"', '{"value":42}']) {
      const reply = { type: "tool-result", callId: 1, result: { ok: true, json } } as const;
      expect(ToolReply.decode(reply)).toEqual({ ok: true, value: reply });
    }
  });

  test("accepts explicit tool failure messages", () => {
    const failure = {
      type: "tool-result",
      callId: 1,
      result: ToolResult.failure("Public failure"),
    } as const;

    expect(ToolReply.decode(failure)).toEqual({ ok: true, value: failure });
  });

  test("rejects replies without a serialized value or public failure message", () => {
    for (const result of [null, {}, { ok: true }, { ok: false, error: { message: 42 } }]) {
      expect(ToolReply.decode({ type: "tool-result", callId: 1, result }).ok).toBe(false);
    }
  });
});

describe("shared tool-call fields", () => {
  test("requires positive safe-integer call IDs in both directions", () => {
    for (const callId of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, "1"]) {
      expect(
        WorkerToMainMessage.decode({ type: "tool-call", callId, name: "read", argsJson: undefined })
          .ok,
      ).toBe(false);
      expect(
        ToolReply.decode({ type: "tool-result", callId, result: { ok: true, json: "42" } }).ok,
      ).toBe(false);
    }
  });

  test("rejects arguments and results that are not JSON text or undefined", () => {
    for (const json of [42, {}, "undefined", "not JSON"]) {
      expect(
        WorkerToMainMessage.decode({ type: "tool-call", callId: 1, name: "read", argsJson: json })
          .ok,
      ).toBe(false);
      expect(
        ToolReply.decode({ type: "tool-result", callId: 1, result: { ok: true, json } }).ok,
      ).toBe(false);
    }
  });
});
