// Submitted code is compiled separately: it must not share this closure's dispatcher or resolvers.
export const PRELUDE_SOURCE = `((dispatch, toolNamesJson) => {
  "use strict";
  // Capture bridge dependencies before submitted code can replace guest globals or
  // prototype methods; later mutations must not rewrite the private call protocol.
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const create = Object.create;
  const apply = Reflect.apply;
  const PromiseCtor = Promise;
  const ErrorCtor = Error;
  const ConversionError = TypeError;
  const pending = new Map();
  const set = Map.prototype.set;
  const get = Map.prototype.get;
  const remove = Map.prototype.delete;
  let nextCallId = 1;

  // Decode on the guest job queue, after the worker releases the admitted call's slot.
  // Promise resolution of a decoded object can invoke guest-defined then getters.
  const decodeResult = async (call) => {
    const json = await call;
    return json === undefined ? undefined : parse(json);
  };

  const tools = create(null);
  for (const name of parse(toolNamesJson)) {
    tools[name] = (args) => {
      const argsJson = stringify(args);
      if (argsJson === undefined && args !== undefined) {
        throw new ConversionError("Tool arguments are not JSON-serializable.");
      }

      const callId = nextCallId;
      // Control records have no prototype: guest toJSON hooks must not rewrite the envelope.
      const call = create(null);
      call.type = "call";
      call.callId = callId;
      call.name = name;
      call.argsJson = argsJson === undefined ? null : argsJson;
      const json = stringify(call);

      return decodeResult(new PromiseCtor((resolve, reject) => {
        const entry = create(null);
        entry.resolve = resolve;
        entry.reject = reject;
        apply(set, pending, [callId, entry]);
        if (dispatch(json)) nextCallId++;
        else apply(remove, pending, [callId]);
      }));
    };
  }
  globalThis.tools = Object.freeze(tools);

  return {
    async run(script) {
      const value = await script(tools);
      const json = stringify(value);
      if (json === undefined && value !== undefined) {
        throw new ConversionError("Return value is not JSON-serializable.");
      }
      return json ?? "null";
    },
    settle(json) {
      const reply = parse(json);
      const entry = apply(get, pending, [reply.callId]);
      if (entry === undefined) throw new ErrorCtor("Unknown guest tool reply.");
      apply(remove, pending, [reply.callId]);
      if (!reply.result.ok) {
        entry.reject(new ErrorCtor(reply.result.error.message));
        return;
      }
      entry.resolve(reply.result.json === null ? undefined : reply.result.json);
    },
  };
})`;
