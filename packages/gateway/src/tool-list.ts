import { z } from "zod";
import { ServerStatus } from "./upstream/upstream.ts";

/** Current upstream metadata only: no callbacks, schemas, or discovery helpers. */
export const ToolList = z.object({
  tools: z.array(z.object({ server: z.string(), name: z.string(), description: z.string() })),
  servers: z.array(ServerStatus),
});
export type ToolList = z.infer<typeof ToolList>;
