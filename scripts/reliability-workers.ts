import { strictEqual } from "node:assert";
import { Worker } from "node:worker_threads";
import { spyOn } from "bun:test";

/** Diagnostic-only dependency probe: the public gateway exposes no worker lifetime hook.
 * Observe real exits without changing dispatch or termination; retain objects only until
 * the next quiescent checkpoint. This does not observe QuickJS handle disposal inside a VM.
 */
export function observeWorkers() {
  const registration = spyOn(Worker.prototype, "on");
  const on = registration.getMockImplementation();
  if (on === undefined) throw new Error("Expected native worker listener registration");

  const seen = new WeakSet<Worker>();
  const pending = new Set<Promise<void>>();
  const retired = new Set<Worker>();
  const counts = { observed: 0, exits: 0, checked: 0, peakActive: 0 };

  registration.mockImplementation(function (this: Worker, ...args: Parameters<Worker["on"]>) {
    if (!seen.has(this)) {
      seen.add(this);
      counts.observed++;
      const exit = Promise.withResolvers<void>();
      pending.add(exit.promise);
      counts.peakActive = Math.max(counts.peakActive, pending.size);

      const exited = () => {
        this.off("exit", exited);
        counts.exits++;
        pending.delete(exit.promise);
        retired.add(this);
        exit.resolve();
      };

      on.call(this, "exit", exited);
    }

    return on.apply(this, args);
  });

  return {
    counts,
    get active() {
      return pending.size;
    },
    async drained() {
      await Promise.all(pending);
      // Exit precedes the executor's final listener removal and promise settlement.
      await Bun.sleep(0);
      strictEqual(pending.size, 0);
      for (const worker of retired) {
        strictEqual(worker.threadId, -1);
        for (const event of ["message", "messageerror", "error", "exit"]) {
          strictEqual(worker.listenerCount(event), 0, `Retained worker ${event} listener`);
        }

        counts.checked++;
      }

      retired.clear();
      registration.mockClear();
      strictEqual(counts.checked, counts.observed);
    },
    [Symbol.dispose]() {
      registration.mockRestore();
    },
  };
}
