import { outsideCode } from "./mentions.js";

/**
 * A pipe table as a block of padded columns.
 *
 * Discord draws no tables, so a reply written for the dashboard with a
 * table in it arrived as a screenful of bars. In a code block the columns
 * line up, which is what a table is for.
 */

const isRow = (line: string): boolean => /\|/.test(line) && line.trim().startsWith("|");
const isDivider = (line: string): boolean => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes("-");
const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

/** The table's rows as lines with their columns padded to one width each. */
function padded(rows: string[][]): string[] {
  const width = rows.reduce((n, r) => Math.max(n, r.length), 0);
  const widths = Array.from({ length: width }, (_, i) => rows.reduce((n, r) => Math.max(n, (r[i] ?? "").length), 0));
  const line = (r: string[]): string => widths.map((w, i) => (r[i] ?? "").padEnd(w)).join("  ").trimEnd();
  const [head, ...body] = rows;
  return [line(head ?? []), widths.map((w) => "-".repeat(w)).join("  "), ...body.map(line)];
}

export function tablesToCode(text: string): string {
  return outsideCode(text, (part) => {
    const lines = part.split("\n");
    const out: string[] = [];
    for (let i = 0; i < lines.length; ) {
      if (isRow(lines[i] ?? "") && isDivider(lines[i + 1] ?? "")) {
        const rows = [cells(lines[i] ?? "")];
        i += 2;
        while (i < lines.length && isRow(lines[i] ?? "")) {
          rows.push(cells(lines[i] ?? ""));
          i += 1;
        }
        out.push("```", ...padded(rows), "```");
        continue;
      }
      out.push(lines[i] ?? "");
      i += 1;
    }
    return out.join("\n");
  });
}
