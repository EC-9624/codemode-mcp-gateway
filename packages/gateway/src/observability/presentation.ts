import { type GatewayLog } from "./events.ts";

/** Only gateway-owned records use this renderer; inherited upstream stderr is not trusted telemetry. */
export function renderLog(record: GatewayLog, terminal: boolean): string {
  if (!terminal) return JSON.stringify(record);

  const details = Object.entries(record.attributes)
    .flatMap(([key, value]) => {
      if (
        key === "gw.execution.calls.completed" ||
        (key === "gw.execution.calls.interrupted" && value === 0)
      )
        return [];

      const name = labels[key] ?? key.replace(/^gw\./u, "");
      if (typeof value === "number" && key.endsWith("duration_ms"))
        return [`duration=${value.toFixed(1)}ms`];

      const text = String(value);

      return [`${name}=${key.endsWith(".id") ? text.slice(0, 8) : text}`];
    })
    .join(" ");

  return Bun.stripANSI(
    `${record.timestamp.slice(11, 23)} ${record.severityText.padEnd(5)} ${record.body} ${details}`,
  )
    .replace(/\p{Cc}/gu, " ")
    .trimEnd();
}

const labels: Readonly<Record<string, string>> = {
  "gw.transport": "transport",
  "gw.session.id": "session",
  "gw.execution.id": "execution",
  "gw.execution.outcome": "outcome",
  "gw.execution.calls.total": "calls",
  "gw.execution.calls.interrupted": "interrupted",
  "gw.execution.limit.resource": "limit",
  "gw.upstream.name": "upstream",
  "gw.upstream.state": "state",
  "gw.upstream.previous_state": "previous",
  "gw.upstream.tools": "tools",
  "gw.tool.name": "tool",
  "gw.tool.call_id": "call",
  "gw.session.close_reason": "reason",
  "gw.shutdown.reason": "reason",
  "process.pid": "pid",
  "server.port": "port",
};
