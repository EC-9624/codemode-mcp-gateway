import { z } from "zod";

const base = { name: z.string(), updatedAt: z.string() };
const failure = z.object({ kind: z.string(), message: z.string() });

/** Shared public status contract; independent of connections and their lifecycle. */
export const ServerStatus = z.discriminatedUnion("state", [
  z.object({
    ...base,
    state: z.literal("connected"),
    toolCount: z.number().int().nonnegative(),
  }),
  z.object({ ...base, state: z.enum(["disabled", "connecting"]), toolCount: z.literal(0) }),
  z.object({
    ...base,
    state: z.enum(["needs-auth", "failed"]),
    toolCount: z.literal(0),
    error: failure,
  }),
]);
export type ServerStatus = z.infer<typeof ServerStatus>;
