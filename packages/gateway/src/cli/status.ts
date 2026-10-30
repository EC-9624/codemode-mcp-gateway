import { type ServerStatus } from "../server-status.ts";
import { type HttpStatus } from "../http/protocol.ts";
import { formatServers, wrapText, type OutputMode } from "./presentation.ts";

export function formatStatus(
  servers: readonly ServerStatus[],
  mode: OutputMode,
  source: { kind: "probe" } | { kind: "http"; port: number; status: HttpStatus },
): string {
  const records = formatServers(servers, mode);
  if (mode.kind === "pipe") return records;

  const header =
    source.kind === "probe"
      ? "Fresh upstream connectivity check"
      : `Gateway http://127.0.0.1:${source.port}/mcp\nPID ${source.status.service.pid} · Uptime ${uptime(source.status.service.uptimeMs)} · Sessions ${source.status.sessions}`;

  return `${wrapText(header, mode.width)}\n\n${records}`;
}

function uptime(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
