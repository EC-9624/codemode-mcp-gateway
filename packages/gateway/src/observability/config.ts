import { GatewayError } from "../errors.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

export function logConfiguration(env: NodeJS.ProcessEnv): { level: LogLevel } {
  const level = env.GW_LOG_LEVEL ?? "info";
  if (level !== "debug" && level !== "info" && level !== "warn" && level !== "error")
    throw new GatewayError("GW_LOG_LEVEL must be debug, info, warn, or error.");

  return { level };
}
