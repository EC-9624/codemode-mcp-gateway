import { parse } from "acorn";
import { Scope, type QuickJSContext, type QuickJSHandle } from "quickjs-emscripten";
import { createVm } from "./runtime";
import { type ToolBridge } from "./guest-tool-bridge";
import { type SandboxResult } from "./sandbox-result";

const TIMEOUT_MS = 1000;
const JOBS_PER_TURN = 100;

/** Worker-local engine. Bridge handles belong to the execution's scope. */
export async function executeEngine(
  code: string,
  installBridge: (vm: QuickJSContext, scope: Scope) => ToolBridge,
): Promise<SandboxResult> {
  using vm = await createVm();
  using bridgeScope = new Scope();
  const bridge = installBridge(vm, bridgeScope);
  return await executeScript(vm, code, bridge);
}

async function executeScript(
  vm: QuickJSContext,
  code: string,
  bridge: ToolBridge,
): Promise<SandboxResult> {
  const runtime = vm.runtime;
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
      if (!runtime.hasPendingJob() && bridge.pendingCalls.size === 0) {
        const value: unknown = JSON.parse(vm.getString(result));
        return { ok: true, value };
      }
    }

    if (runtime.hasPendingJob()) {
      // Yield to host timers/I/O instead of monopolizing the microtask queue.
      await Bun.sleep(0);
      continue;
    }

    if (bridge.pendingCalls.size === 0) {
      return {
        ok: false,
        error: {
          kind: "script",
          message: "Script is waiting on a promise with no pending host calls.",
        },
      };
    }

    // An interrupt handler cannot expire a script while QuickJS is idle.
    await Promise.race([deadline.expired, bridge.failed, ...bridge.pendingCalls]);
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
    // Restricting body syntax would reject valid JavaScript; only wrapper escapes are forbidden.
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
  // Disposing an error result here would invalidate the handle the caller must inspect.
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

// Compiling user code inside this closure would expose raw callbacks and captured codecs.
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
  if (state.type === "fulfilled" && state.notAPromise) {
    return {
      ok: false,
      error: { kind: "script", message: scriptErrorMessage(context.dump(handle)) },
    };
  }
  if (state.type === "fulfilled") state.value.dispose();
  if (state.type === "rejected") state.error.dispose();
  return { ok: false, error: { kind: "script", message: scriptErrorMessage(undefined) } };
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
