import { type ServerStatus } from "../upstream/upstream.ts";

export type OutputMode = { kind: "terminal"; width: number } | { kind: "pipe" };
export type TextOutput = { stdout: string; stderr: string };

export function outputMode(stream: { isTTY?: boolean; columns?: number }): OutputMode {
  return stream.isTTY
    ? { kind: "terminal", width: Math.max(1, stream.columns ?? 80) }
    : { kind: "pipe" };
}

/** Keep a record on one line and never let upstream metadata supply terminal escapes. */
export function plainText(text: string): string {
  return Bun.stripANSI(text).replace(/\s+/gu, " ").trim();
}

export function wrapText(text: string, width: number): string {
  return text
    .split("\n")
    .map((line) => Bun.wrapAnsi(plainText(line), width, { hard: true }))
    .join("\n");
}

export function tabularRecords(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map(plainText).join("\t")).join("\n");
}

export function table(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  width: number,
): string {
  const widths = headers.slice(0, -1).map((header, index) =>
    Math.min(
      rows.reduce(
        (size, row) => Math.max(size, Bun.stringWidth(plainText(row[index] ?? ""))),
        Bun.stringWidth(header),
      ),
      Math.max(1, Math.floor(width / 2) - 2),
    ),
  );

  widths.push(
    Math.max(1, width - widths.reduce((total, size) => total + size, 0) - widths.length * 2),
  );

  return [headers, ...rows]
    .map((row) =>
      clip(
        row
          .map((value, index) => {
            const size = widths[index] ?? 1;
            const text = clip(plainText(value), size);

            return text + " ".repeat(Math.max(0, size - Bun.stringWidth(text)));
          })
          .join("  ")
          .trimEnd(),
        width,
      ),
    )
    .join("\n");
}

export function formatServers(servers: readonly ServerStatus[], mode: OutputMode): string {
  if (mode.kind === "pipe")
    return tabularRecords(
      servers.map((server) => [
        server.name,
        server.state,
        String(server.toolCount),
        "error" in server ? server.error.message : "",
      ]),
    );

  const rows = servers.map((server) => [
    server.name,
    server.state,
    server.state === "connected" ? String(server.toolCount) : "—",
  ]);

  const details = servers.flatMap((server) =>
    "error" in server ? [`${server.name}: ${server.error.message}`] : [],
  );

  return [
    table(["UPSTREAM", "STATUS", "TOOLS"], rows, mode.width),
    ...(details.length === 0
      ? []
      : ["", "Details:", ...details.map((detail) => wrapText(detail, mode.width))]),
  ].join("\n");
}

/** A delayed, terminal-only hint; cleanup also runs when the operation rejects or is cancelled. */
export async function withProgress<T>(
  message: string,
  enabled: boolean,
  operation: () => Promise<T>,
): Promise<T> {
  const mode = outputMode(process.stderr);
  if (!enabled || mode.kind === "pipe") return operation();

  let shown = false;

  const timer = setTimeout(() => {
    process.stderr.write(clip(plainText(message), Math.max(1, mode.width - 1)));
    shown = true;
  }, 200);

  try {
    return await operation();
  } finally {
    clearTimeout(timer);
    if (shown) process.stderr.write("\r\u001b[2K");
  }
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function clip(text: string, width: number): string {
  if (Bun.stringWidth(text) <= width) return text;

  // Whole graphemes keep wide and combined characters inside the column budget.
  let value = "";
  let used = 0;
  for (const { segment } of graphemes.segment(text)) {
    const size = Bun.stringWidth(segment);
    if (used + size > width - 1) break;

    value += segment;
    used += size;
  }

  return value + "…";
}
