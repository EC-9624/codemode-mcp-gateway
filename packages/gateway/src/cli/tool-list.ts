import { type ToolList } from "../tool-list.ts";
import {
  plainText,
  table,
  tabularRecords,
  wrapText,
  type OutputMode,
  type TextOutput,
} from "./presentation.ts";

export type ToolListOutput =
  | { kind: "page"; server: string | undefined; offset: number }
  | { kind: "all"; server: string | undefined }
  | { kind: "json"; server: string | undefined };

export const toolPageSize = 50;

/** Format an already-selected catalog; pagination affects text only, never the HTTP snapshot. */
export function formatToolList(
  listing: ToolList,
  output: Exclude<ToolListOutput, { kind: "json" }>,
  mode: OutputMode,
): TextOutput {
  const offset = output.kind === "page" ? output.offset : 0;

  const page =
    output.kind === "page" ? listing.tools.slice(offset, offset + toolPageSize) : listing.tools;

  const next = offset + page.length;
  const footer: string[] = [];
  if (listing.tools.length === 0) footer.push("No tools available.");
  else if (page.length === 0)
    footer.push(
      `No tools at offset ${offset} (${listing.tools.length} total).`,
      "Reset: --offset 0",
    );
  else if (output.kind === "page") {
    footer.push(`Showing ${offset + 1}–${next} of ${listing.tools.length} tools`);
    if (next < listing.tools.length) footer.push(`Next: --offset ${next}`);
  } else footer.push(`${listing.tools.length} tools`);

  const unavailable = listing.servers.filter((server) => server.state !== "connected");

  const warning =
    unavailable.length === 0
      ? ""
      : `Unavailable upstreams: ${unavailable.map((server) => `${plainText(server.name)} (${server.state})`).join(", ")}. Run gw status for details.`;

  if (mode.kind === "pipe") {
    const hints = output.kind === "page" && listing.tools.length > 0 ? footer : [];

    return {
      stdout: tabularRecords(page.map((tool) => [tool.name, tool.description])),
      stderr: [...hints, ...(warning === "" ? [] : [warning])].join("\n"),
    };
  }

  const title =
    output.server === undefined ? "Available upstream tools" : `Tools from ${output.server}`;

  const rows = page.map((tool) => [
    output.server === undefined ? tool.name : tool.name.slice(tool.server.length + 1),
    tool.description,
  ]);

  return {
    stdout: [
      wrapText(title, mode.width),
      ...(rows.length === 0 ? [] : ["", table(["TOOL", "DESCRIPTION"], rows, mode.width)]),
      "",
      ...footer.map((line) => wrapText(line, mode.width)),
    ].join("\n"),
    stderr: wrapText(warning, mode.width),
  };
}
