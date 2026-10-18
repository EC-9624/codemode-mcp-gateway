import { z } from "zod";
import { ServerStatus } from "../upstream/upstream.ts";

/** Management snapshot served over HTTP; tool metadata uses the shared ToolList contract. */
export const HttpStatus = z.object({
  service: z.object({
    ready: z.literal(true),
    pid: z.number().int().positive(),
    instanceId: z.uuid(),
    uptimeMs: z.number().nonnegative(),
  }),
  sessions: z.number().int().nonnegative(),
  upstreams: z.array(ServerStatus),
});
export type HttpStatus = z.infer<typeof HttpStatus>;
