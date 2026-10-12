import { Buffer } from "node:buffer";
import { Scope, type QuickJSContext, type QuickJSHandle } from "quickjs-emscripten";
import { createVm } from "./vm.js";
import { type ToolBridge } from "./guest-bridge.js";
import { type ExecutionLimits } from "./limits.js";
import { type GuestResult } from "./protocol.js";
import { prepareScript, prepareRunner, startScript } from "./script.js";

const JOBS_PER_TURN = 100;

/** Worker-local engine. Bridge handles belong to the execution's scope. */
export async function executeEngine(
  code: string,
  limits: ExecutionLimits,
  installToolBridge: (vm: QuickJSContext, scope: Scope) => ToolBridge,
  interrupt: Int32Array<SharedArrayBuffer>,
): Promise<GuestResult> {
  using vm = await createVm(limits);
  using bridgeScope = new Scope();
  const bridge = installToolBridge(vm, bridgeScope);

  const result = await executeScript(
    vm,
    code,
    limits.timeoutMs,
    limits.maxOutputBytes,
    bridge,
    interrupt,
  );

  // Error conversion can invoke tools after the job loop's last failure/limit check.
  const stopped = bridgeOutcome(bridge);
  if (stopped) return stopped;

  if (
    !result.ok &&
    result.error.kind === "script" &&
    Buffer.byteLength(result.error.message, "utf8") > limits.maxOutputBytes
  ) {
    return outputLimit(limits.maxOutputBytes);
  }

  return result;
}

async function executeScript(
  vm: QuickJSContext,
  code: string,
  timeoutMs: number,
  maxOutputBytes: number,
  bridge: ToolBridge,
  interrupt: Int32Array<SharedArrayBuffer>,
): Promise<GuestResult> {
  const runtime = vm.runtime;
  using deadline = createDeadline(timeoutMs);

  // QuickJS polls this shared flag via Atomics even while worker message handling is blocked.
  const interrupted = () => Atomics.load(interrupt, 0) !== 0;

  // Infrastructure failures throw; admission limits and deadlines are execution results.
  const checkpoint = (): GuestResult | undefined => {
    const stopped = bridgeOutcome(bridge);
    if (stopped) return stopped;

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

  runtime.setInterruptHandler(
    () => bridge.failure !== undefined || interrupted() || deadline.passed(),
  );

  const submission = prepareScript(code);
  const parsed = checkpoint();
  if (parsed) return parsed;

  if (!submission.ok) {
    return { ok: false, error: { kind: "script", message: submission.message } };
  }

  using prelude = prepareRunner(vm, bridge.dispatcher, bridge.toolNames);
  const prepared = checkpoint();
  if (prepared) return prepared;

  if (prelude.error) throw new Error("Sandbox prelude initialization failed.");

  bridge.attach(prelude.value);
  using runner = vm.getProp(prelude.value, "run");

  using json = vm.getProp(vm.global, "JSON");
  using stringify = vm.getProp(json, "stringify");

  const failScript = (error: QuickJSHandle): GuestResult => {
    const result = scriptFailure(vm, error, stringify);

    // Error conversion can run guest getters/toJSON and exhaust the deadline.
    return checkpoint() ?? result;
  };

  using evaluated = startScript(vm, submission.source, runner);
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
    await Promise.race([deadline.expired, bridge.failureSignal, bridge.changeSignal]);
  }
}

/** Private infrastructure failures throw; a recorded admission limit is the outcome. */
function bridgeOutcome(bridge: ToolBridge): GuestResult | undefined {
  const failure = bridge.failure;
  if (failure === undefined) return undefined;

  if (failure.kind === "limit") return { ok: false, error: failure.limit };

  throw failure.error;
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

function scriptFailure(
  context: QuickJSContext,
  handle: QuickJSHandle,
  stringify: QuickJSHandle,
): GuestResult {
  if (context.typeof(handle) === "string") {
    // dump/getString truncate raw NULs. Captured JSON encoding preserves the
    // entire primitive message even after the guest replaces JSON.stringify.
    using encoded = context.callFunction(stringify, context.undefined, handle);
    if (encoded.error) {
      return {
        ok: false,
        error: { kind: "script", message: scriptErrorMessage(context.dump(encoded.error)) },
      };
    }

    const message: unknown = JSON.parse(context.getString(encoded.value));

    return { ok: false, error: { kind: "script", message: scriptErrorMessage(message) } };
  }

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
