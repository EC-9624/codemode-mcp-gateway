import { GuestCall } from "../../src/runtime/protocol.ts";

const decode = GuestCall.decode.bind(GuestCall);
GuestCall.decode = () => {
  // A persistent VM fault could also fail final extraction after the guest catches it.
  GuestCall.decode = decode;
  throw new Error("Private worker dispatch details");
};

// A static import would start the real entry before the worker-local fault is installed.
await import("../../src/runtime/worker.ts");
