import { parse } from "acorn";
import { Scope, type QuickJSContext, type QuickJSHandle } from "quickjs-emscripten";
import { createVm } from "./runtime";
import { installTools, type SandboxTool, type ToolBridge } from "./tool-bridge";

export { ToolResult, type SandboxTool } from "./tool-bridge";

const TIMEOUT_MS = 1000;
const JOBS_PER_TURN = 100;

type SandboxResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { kind: "script" | "timeout"; message: string } };

/** Execute a JavaScript async function body with only explicitly supplied tools. */
export async function execute(
  code: string,
  tools: Readonly<Record<string, SandboxTool>> = {},
): Promise<SandboxResult> {
  using vm = await createVm();
  using bridgeScope = new Scope();
  const bridge = installTools(vm, tools, bridgeScope);
  return await executeScript(vm, code, bridge);
}

async function executeScript(
  vm: QuickJSContext,
  code: string,
  bridge: ToolBridge,
): Promise<SandboxResult> {
  const runtime = vm.runtime;
  const { pendingCalls } = bridge;
  using deadline = createDeadline();

  runtime.setInterruptHandler(() => performance.now() >= deadline.expiresAt);

  const submission = buildScript(code);
  if (performance.now() >= deadline.expiresAt) return timeoutResult();
  if (!submission.ok) {
    return { ok: false, error: { kind: "script", message: submission.message } };
  }
  using evaluated = startScript(vm, submission.source);

  if (evaluated.error) {
    if (performance.now() >= deadline.expiresAt) return timeoutResult();
    return scriptFailure(vm, evaluated.error);
  }

  while (true) {
    if (!bridge.failure.ok) throw bridge.failure.error;
    if (performance.now() >= deadline.expiresAt) return timeoutResult();

    // Resolving a guest promise queues work; QuickJS does not run it for us.
    using jobs = runtime.executePendingJobs(JOBS_PER_TURN);
    if (performance.now() >= deadline.expiresAt) return timeoutResult();
    if (jobs.error) {
      return scriptFailure(vm, jobs.error);
    }

    const state = vm.getPromiseState(evaluated.value);
    if (state.type === "rejected") {
      using error = state.error;
      if (performance.now() >= deadline.expiresAt) return timeoutResult();
      return scriptFailure(vm, error);
    }

    if (state.type === "fulfilled") {
      using result = state.value;
      // A return does not abandon calls already started by the script or toJSON.
      if (!runtime.hasPendingJob() && pendingCalls.size === 0) {
        const value: unknown = JSON.parse(vm.getString(result));
        return { ok: true, value };
      }
    }

    if (runtime.hasPendingJob()) {
      // Yield to host timers/I/O instead of monopolizing the microtask queue.
      await Bun.sleep(0);
      continue;
    }

    if (pendingCalls.size === 0) {
      return {
        ok: false,
        error: {
          kind: "script",
          message: "Script is waiting on a promise with no pending host calls.",
        },
      };
    }

    // An interrupt handler cannot expire a script while QuickJS is idle.
    await Promise.race([deadline.expired, ...pendingCalls]);
  }
}

function createDeadline() {
  const expiresAt = performance.now() + TIMEOUT_MS;
  const expiration = Promise.withResolvers<void>();
  const timer = setTimeout(expiration.resolve, TIMEOUT_MS);
  return {
    expiresAt,
    expired: expiration.promise,
    [Symbol.dispose]() {
      clearTimeout(timer);
    },
  };
}

function timeoutResult(): SandboxResult {
  return {
    ok: false,
    error: { kind: "timeout", message: "Execution exceeded the 1-second limit." },
  };
}

function buildScript(code: string): { ok: true; source: string } | { ok: false; message: string } {
  const prefix = '(async (tools) => {\n"use strict";\n';
  const source = `${prefix}${code}\n})`;
  let program: ReturnType<typeof parse>;
  try {
    // Check only the complete wrapper shape. QuickJS still executes the program;
    // Acorn is not an interpreter or a whitelist of language constructs.
    program = parse(source, { ecmaVersion: "latest", sourceType: "script" });
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { ok: false, message: error.message };
  }
  const statement = program.body[0];
  if (
    program.body.length !== 1 ||
    statement?.type !== "ExpressionStatement" ||
    statement.expression.type !== "ArrowFunctionExpression" ||
    !statement.expression.async ||
    statement.expression.body.type !== "BlockStatement" ||
    statement.expression.body.start !== prefix.indexOf("{") ||
    statement.expression.body.end !== source.length - 1
  ) {
    return { ok: false, message: "Source must stay inside the submitted async function body." };
  }
  return { ok: true, source };
}

function startScript(vm: QuickJSContext, source: string) {
  // Transfer failing results to the caller; retain successful setup handles only
  // until the runner has started. No user source is interpolated into the prelude.
  const factory = vm.evalCode(PRELUDE_SOURCE, "sandbox-prelude.js");
  if (factory.error) return factory;
  using factoryHandle = factory.value;
  using hostTools = vm.getProp(vm.global, "tools");
  const runner = vm.callFunction(factoryHandle, vm.undefined, hostTools);
  if (runner.error) return runner;
  using run = runner.value;

  const compiled = vm.evalCode(source, "sandbox.js");
  if (compiled.error) return compiled;
  using script = compiled.value;
  return vm.callFunction(run, vm.undefined, script);
}

// This factory's closure is private. The independently compiled user function
// sees its own scope and the VM globals, never hostTools or the captured codecs.
const PRELUDE_SOURCE = `((hostTools) => {
    "use strict";
    const stringify = JSON.stringify;
    const parse = JSON.parse;
    const ResultError = TypeError;
    const decodeResult = async (call) => {
      const json = await call;
      return json === undefined ? undefined : parse(json);
    };

    const tools = Object.create(null);
    for (const name of Object.keys(hostTools)) {
      const invoke = hostTools[name];
      tools[name] = (args) => {
        const json = stringify(args);
        if (json === undefined && args !== undefined) {
          throw new ResultError("Tool arguments are not JSON-serializable.");
        }
        return decodeResult(invoke(json));
      };
    }
    globalThis.tools = Object.freeze(tools);

    return async (script) => {
      const value = await script(tools);
      const json = stringify(value);
      if (json === undefined && value !== undefined) {
        throw new ResultError("Return value is not JSON-serializable.");
      }
      return json ?? "null";
    };
  })`;

function scriptFailure(context: QuickJSContext, handle: QuickJSHandle): SandboxResult {
  // dump consumes promise handles (including nested promise reasons). A thrown
  // promise is an opaque thrown value, not a result to unwrap. Keep the caller's
  // handle borrowed and release only owned promise-state handles here.
  const state = context.getPromiseState(handle);
  let error: unknown;
  if (state.type === "fulfilled") {
    if (state.notAPromise) error = context.dump(handle);
    else state.value.dispose();
  } else if (state.type === "rejected") {
    state.error.dispose();
  }
  return { ok: false, error: { kind: "script", message: scriptErrorMessage(error) } };
}

function scriptErrorMessage(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }

  return "Script threw a value without an error message.";
}
