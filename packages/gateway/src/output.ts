import { randomUUID } from "node:crypto";
import { promises } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INLINE_BYTES = 40_000;
const MARKER = "\n\n… output truncated …\n\n";

/**
 * Private output files live until their MCP session closes; native harness tools read their paths.
 * The owner must drain format() calls before close() so late writes cannot outlive cleanup.
 */
export class OutputFiles {
  private directory: Promise<string> | undefined;

  async format(text: string, diagnose: (error: Error) => void): Promise<string> {
    if (Buffer.byteLength(text, "utf8") <= INLINE_BYTES) return text;

    const bytes = Buffer.from(text, "utf8");

    let notice: string;
    try {
      // Concurrent outputs share one directory creation. A failed attempt must not
      // cache rejection forever; later output can retry without replaying tool calls.
      this.directory ??= promises.mkdtemp(join(tmpdir(), "cmg-output-")).catch((cause: unknown) => {
        this.directory = undefined;
        throw cause;
      });
      const path = join(await this.directory, `${randomUUID()}.txt`);
      await promises.writeFile(path, bytes, { mode: 0o600, flag: "wx" });
      notice = `\n\n[Full output: ${path}]\nRead with your native file or shell tools.`;
    } catch (cause) {
      notice = "\n\n[Full output could not be saved.]";
      try {
        diagnose(new Error("Full output could not be saved.", { cause }));
      } catch {
        // A diagnostic callback must not discard output after tool side effects already ran.
      }
    }

    // The notice and path count toward the response budget, not just the preview text.
    const available = Math.max(0, INLINE_BYTES - Buffer.byteLength(MARKER + notice, "utf8"));
    let head = Math.floor(available / 2);
    let tail = bytes.length - (available - head);
    // UTF-8 continuation bytes start with 10. Shrink both slices to complete code points
    // so decoding adds no replacement characters and cannot exceed the byte budget.
    while (head > 0 && (bytes[head] ?? 0) >> 6 === 2) head--;

    while (tail < bytes.length && (bytes[tail] ?? 0) >> 6 === 2) tail++;

    return (
      bytes.subarray(0, head).toString("utf8") +
      MARKER +
      bytes.subarray(tail).toString("utf8") +
      notice
    );
  }

  async close(): Promise<void> {
    if (this.directory === undefined) return;

    let directory: string;
    try {
      directory = await this.directory;
    } catch {
      // A failed mkdtemp created no owned directory.
      return;
    }

    await promises.rm(directory, { recursive: true, force: true });
  }
}
