import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { KosModule, ModuleContext } from "../modules/loader.js";
import { requireServices } from "../modules/loader.js";
import type { Workspace } from "../store/workspace.js";
import { runDisplayQuery } from "../systems/display.js";

/**
 * The `export` tool module: turn a read-only query into a file the owner can
 * actually take somewhere. Formats are the plain-text ones SQLite data maps to
 * cleanly; a spreadsheet or a report starts as one of these.
 *
 * Queries run through the same read-only, row-capped display path the UI uses,
 * so an export cannot write and cannot pull an unbounded result into memory.
 * Output paths resolve through the jail, so an export cannot escape the
 * workspace. Both properties make this a safe-tier tool.
 */

function str(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== "string" || v === "") throw new Error(`missing arg: ${key}`);
  return v;
}

type Row = Record<string, unknown>;

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** RFC 4180: quote when the value holds a comma, quote, or newline. */
export function toCsv(rows: Row[]): string {
  if (rows.length === 0) return "";
  const columns = Object.keys(rows[0]!);
  const escape = (value: unknown): string => {
    const s = cell(value);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.join(",")];
  for (const row of rows) lines.push(columns.map((c) => escape(row[c])).join(","));
  return `${lines.join("\n")}\n`;
}

/** A GitHub-flavored table; pipes in values are escaped so columns hold. */
export function toMarkdown(rows: Row[], title?: string): string {
  const head = title ? `# ${title}\n\n` : "";
  if (rows.length === 0) return `${head}(no rows)\n`;
  const columns = Object.keys(rows[0]!);
  const escape = (value: unknown): string =>
    cell(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const lines = [
    `| ${columns.join(" | ")} |`,
    `| ${columns.map(() => "---").join(" | ")} |`,
  ];
  for (const row of rows) {
    lines.push(`| ${columns.map((c) => escape(row[c])).join(" | ")} |`);
  }
  return `${head}${lines.join("\n")}\n`;
}

const FORMATS = ["csv", "markdown", "json"] as const;
type Format = (typeof FORMATS)[number];

function render(format: Format, rows: Row[], title?: string): string {
  if (format === "csv") return toCsv(rows);
  if (format === "markdown") return toMarkdown(rows, title);
  return `${JSON.stringify(rows, null, 2)}\n`;
}

function defineExportTool(ws: Workspace, ctx: ModuleContext): void {
  ctx.registerTool(
    {
      name: "export.query",
      description:
        "Run a read-only SELECT and write the result to a workspace file as csv, markdown, or json. Returns the path and row count. Use this to hand the owner a file rather than pasting a big table into chat.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "a single SELECT/WITH" },
          path: {
            type: "string",
            description: "workspace-relative output path, e.g. exports/spend.csv",
          },
          format: { type: "string", enum: [...FORMATS] },
          title: {
            type: "string",
            description: "heading, markdown only",
          },
          rowCap: { type: "number" },
        },
        required: ["query", "path", "format"],
      },
    },
    (input) => {
      const format = str(input, "format") as Format;
      if (!FORMATS.includes(format)) {
        throw new Error(`unsupported format: ${format} (use ${FORMATS.join(", ")})`);
      }
      const rowCap =
        typeof input.rowCap === "number" && input.rowCap > 0
          ? Math.floor(input.rowCap)
          : undefined;
      const result = runDisplayQuery(ws.reader, str(input, "query"), {
        ...(rowCap !== undefined ? { rowCap } : {}),
      });
      const rel = str(input, "path");
      const abs = ws.resolve(rel);
      mkdirSync(dirname(abs), { recursive: true });
      const title = typeof input.title === "string" ? input.title : undefined;
      writeFileSync(abs, render(format, result.rows, title), "utf8");
      return JSON.stringify({
        path: rel,
        format,
        rows: result.rows.length,
        truncated: result.truncated,
      });
    },
    { floor: "safe" },
    { tags: ["export", "systems"] },
  );
}

export const exportModule: KosModule = {
  manifest: {
    name: "export",
    version: "1.0.0",
    provides: [{ kind: "tool", name: "export.query", version: "1.0.0" }],
    riskTier: "safe",
  },
  activate(ctx) {
    const { workspace } = requireServices(ctx);
    defineExportTool(workspace, ctx);
  },
};
