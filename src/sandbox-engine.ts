import { parse } from "acorn";
import { Buffer } from "node:buffer";
import { Scope, type QuickJSContext, type QuickJSHandle } from "quickjs-emscripten";
import { createVm, type VmLimits } from "./runtime";
import { type ToolBridge } from "./guest-tool-bridge";
import { type GuestResult } from "./sandbox-result";

const JOBS_PER_TURN = 100;

/** Worker-local engine. Bridge handles belong to the execution's scope. */
export async function executeEngine(
  code: string,
  options: VmLimits & { timeoutMs: number; maxOutputBytes: number },
  installToolBridge: (vm: QuickJSContext, scope: Scope) => ToolBridge,
  interrupt?: Int32Array<SharedArrayBuffer>,
): Promise<GuestResult> {
  using vm = await createVm(options);
  using bridgeScope = new Scope();
  const bridge = installToolBridge(vm, bridgeScope);

  const result = await executeScript(
    vm,
    code,
    options.timeoutMs,
    options.maxOutputBytes,
    bridge,
    interrupt,
  );

  // Error conversion can invoke tools after the job loop's last failure/limit check.
  const failure = bridge.failure;
  if (!failure.ok) {
    if ("limit" in failure) return { ok: false, error: failure.limit };

    throw failure.error;
  }

  if (
    !result.ok &&
    result.error.kind === "script" &&
    Buffer.byteLength(result.error.message, "utf8") > options.maxOutputBytes
  ) {
    return outputLimit(options.maxOutputBytes);
  }

  return result;
}

async function executeScript(
  vm: QuickJSContext,
  code: string,
  timeoutMs: number,
  maxOutputBytes: number,
  bridge: ToolBridge,
  interrupt: Int32Array<SharedArrayBuffer> | undefined,
): Promise<GuestResult> {
  const runtime = vm.runtime;
  using deadline = createDeadline(timeoutMs);

  // QuickJS polls this shared flag via Atomics even while worker message handling is blocked.
  // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Atomics
  const interrupted = () => interrupt !== undefined && Atomics.load(interrupt, 0) !== 0;

  // Infrastructure failures throw; admission limits and deadlines are execution results.
  const checkpoint = (): GuestResult | undefined => {
    const failure = bridge.failure;
    if (!failure.ok) {
      if ("limit" in failure) return { ok: false, error: failure.limit };

      throw failure.error;
    }

    if (interrupted()) {
      return {
        ok: false,
        error: { kind: "timeout", message: "Execution interrupted by the parent." },
      };
    }

    if (!deadline.passed()) return undefined;

    return {
      ok: false,
      error: { kind: "timeout", message: `Execution exceeded the ${timeoutMs} ms limit.` },
    };
  };

  const failScript = (error: QuickJSHandle): GuestResult => {
    const result = scriptFailure(vm, error);

    // Error conversion can run guest getters/toJSON and exhaust the deadline.
    return checkpoint() ?? result;
  };

  runtime.setInterruptHandler(() => !bridge.failure.ok || interrupted() || deadline.passed());

  const submission = prepareScript(code);
  const parsed = checkpoint();
  if (parsed) return parsed;

  if (!submission.ok) {
    return { ok: false, error: { kind: "script", message: submission.message } };
  }

  using runner = prepareRunner(vm);
  const prepared = checkpoint();
  if (prepared) return prepared;

  if (runner.error) throw new Error("Sandbox prelude initialization failed.");

  using evaluated = startScript(vm, submission.source, runner.value);
  // An interrupted start surfaces as an error; the checkpoint classifies it first.
  const started = checkpoint();
  if (started) return started;

  if (evaluated.error) return failScript(evaluated.error);

  while (true) {
    const turn = checkpoint();
    if (turn) return turn;

    // Resolving a guest promise queues work; QuickJS does not run it for us.
    using jobs = runtime.executePendingJobs(JOBS_PER_TURN);
    const pumped = checkpoint();
    if (pumped) return pumped;

    if (jobs.error) return failScript(jobs.error);

    const state = vm.getPromiseState(evaluated.value);
    if (state.type === "rejected") {
      using error = state.error;

      return failScript(error);
    }

    if (state.type === "fulfilled") {
      using result = state.value;
      // A return does not abandon calls already started by the script or toJSON.
      if (!runtime.hasPendingJob() && bridge.pendingCalls.size === 0) {
        const json = vm.getString(result);
        if (Buffer.byteLength(json, "utf8") > maxOutputBytes) return outputLimit(maxOutputBytes);

        const value: unknown = JSON.parse(json);

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
    await Promise.race([deadline.expired, bridge.failureSignal, ...bridge.pendingCalls]);
  }
}

function outputLimit(maximum: number): GuestResult {
  return {
    ok: false,
    error: {
      kind: "limit",
      resource: "output",
      maximum,
      message: `Output exceeds the ${maximum} byte limit.`,
    },
  };
}

function createDeadline(timeoutMs: number) {
  const expiresAt = performance.now() + timeoutMs;
  const expiration = Promise.withResolvers<void>();
  const timer = setTimeout(expiration.resolve, timeoutMs);

  return {
    expired: expiration.promise,
    passed: () => performance.now() >= expiresAt,
    [Symbol.dispose]() {
      clearTimeout(timer);
    },
  };
}

function prepareScript(
  code: string,
): { ok: true; source: string } | { ok: false; message: string } {
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

function prepareRunner(vm: QuickJSContext) {
  // Disposing an error result here would invalidate the handle the caller must inspect.
  const factory = vm.evalCode(PRELUDE_SOURCE, "sandbox-prelude.js");
  if (factory.error) return factory;

  using factoryHandle = factory.value;
  using hostTools = vm.getProp(vm.global, "tools");

  return vm.callFunction(factoryHandle, vm.undefined, hostTools);
}

function startScript(vm: QuickJSContext, source: string, runner: QuickJSHandle) {
  const compiled = vm.evalCode(source, "sandbox.js");
  if (compiled.error) return compiled;

  using script = compiled.value;

  return vm.callFunction(runner, vm.undefined, script);
}

// Compiling user code inside this closure would expose raw callbacks and captured codecs.
const PRELUDE_SOURCE = `((hostTools) => {
    "use strict";
    const stringify = JSON.stringify;
    const parse = JSON.parse;
    const ConversionError = TypeError;
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
          throw new ConversionError("Tool arguments are not JSON-serializable.");
        }
        return decodeResult(invoke(json));
      };
    }
    globalThis.tools = Object.freeze(tools);

    return async (script) => {
      const value = await script(tools);
      const json = stringify(value);
      if (json === undefined && value !== undefined) {
        throw new ConversionError("Return value is not JSON-serializable.");
      }
      return json ?? "null";
    };
  })`;

function scriptFailure(context: QuickJSContext, handle: QuickJSHandle): GuestResult {
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
