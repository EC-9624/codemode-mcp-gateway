import { GatewayError } from "../errors.ts";

export type SignalExport = {
  endpoint: string;
  headers: Record<string, string>;
  timeoutMillis: number;
};
export type TelemetryExport = {
  traces: SignalExport | undefined;
  metrics: SignalExport | undefined;
};

/** Explicit endpoints/exporters opt in. Logging configuration alone never enables network delivery. */
export function telemetryConfiguration(env: NodeJS.ProcessEnv): TelemetryExport {
  if (env.OTEL_SDK_DISABLED === "true") return { traces: undefined, metrics: undefined };

  return { traces: signalExport(env, "TRACES"), metrics: signalExport(env, "METRICS") };
}

function signalExport(
  env: NodeJS.ProcessEnv,
  signal: "TRACES" | "METRICS",
): SignalExport | undefined {
  const specific = env[`OTEL_EXPORTER_OTLP_${signal}_ENDPOINT`];

  const exporter =
    env[`OTEL_${signal}_EXPORTER`] ||
    (specific || env.OTEL_EXPORTER_OTLP_ENDPOINT ? "otlp" : "none");

  if (exporter === "none") return;

  if (exporter !== "otlp") throw new GatewayError(`OTEL_${signal}_EXPORTER must be otlp or none.`);

  const protocol =
    env[`OTEL_EXPORTER_OTLP_${signal}_PROTOCOL`] ||
    env.OTEL_EXPORTER_OTLP_PROTOCOL ||
    "http/protobuf";

  if (protocol !== "http/protobuf")
    throw new GatewayError(
      `Gateway telemetry supports only OTLP http/protobuf. Set OTEL_EXPORTER_OTLP_${signal}_PROTOCOL=http/protobuf or unset it and use OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf.`,
    );

  const endpoint = specific || env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318";
  if (!URL.canParse(endpoint))
    throw new GatewayError("The OTLP endpoint must be an absolute HTTP or HTTPS URL.");

  const url = new URL(endpoint);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
    throw new GatewayError(
      "The OTLP endpoint must use HTTP or HTTPS without URL credentials or a fragment. Use OTEL_EXPORTER_OTLP_HEADERS for authentication.",
    );

  if (!specific) url.pathname = `${url.pathname.replace(/\/$/u, "")}/v1/${signal.toLowerCase()}`;

  const timeoutMillis = Number(
    env[`OTEL_EXPORTER_OTLP_${signal}_TIMEOUT`] || env.OTEL_EXPORTER_OTLP_TIMEOUT || 1000,
  );

  if (!Number.isInteger(timeoutMillis) || timeoutMillis < 1 || timeoutMillis > 2000)
    throw new GatewayError(
      "The OTLP export timeout must be between 1 and 2000 milliseconds to bound gateway shutdown.",
    );

  const headers: Record<string, string> = {};

  const source =
    env[`OTEL_EXPORTER_OTLP_${signal}_HEADERS`] || env.OTEL_EXPORTER_OTLP_HEADERS || "";

  try {
    for (const entry of source.split(",").filter((entry) => entry.trim() !== "")) {
      const split = entry.indexOf("=");
      if (split < 1) throw new Error("Invalid header");

      const key = entry.slice(0, split).trim();
      const value = decodeURIComponent(entry.slice(split + 1).trim());
      new Headers({ [key]: value });
      headers[key] = value;
    }
  } catch {
    throw new GatewayError(
      "OTLP headers must be comma-separated name=value pairs with valid percent-encoded values.",
    );
  }

  return { endpoint: url.href, headers, timeoutMillis };
}
