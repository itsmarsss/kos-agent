import type { ArtifactKind } from "./artifacts.js";

/**
 * What an artifact can be taken away as, by kind: the server makes the file
 * (GET /api/artifacts/<id>/export?format=) and the dashboard's menus offer
 * only these.
 *
 *  - pdf:  printed by KOS's own headless Chrome; a deck a slide a page.
 *  - md:   a doc's text as Markdown.
 *  - html: one file that opens offline, its data frozen as it was.
 *  - csv:  a sheet's tab, its values worked out; every tab is a zip of them.
 */
export const EXPORT_FORMATS = ["pdf", "md", "html", "csv"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const isExportFormat = (v: unknown): v is ExportFormat => (EXPORT_FORMATS as readonly unknown[]).includes(v);

export const KIND_EXPORTS: Record<ArtifactKind, readonly ExportFormat[]> = {
  page: ["pdf", "html"],
  doc: ["pdf", "md", "html"],
  deck: ["pdf", "html"],
  sheet: ["csv", "html"],
};

/** A format as the menus name it. */
export const EXPORT_WORDS: Record<ExportFormat, string> = { pdf: "PDF", md: "Markdown", html: "HTML", csv: "CSV" };

/** The longest a file's name runs, before its extension. */
const NAME_MAX = 100;

/**
 * A file name from an artifact's title: what no disk takes (slashes, colons,
 * control characters, the characters Windows reserves) dropped, its spaces
 * collapsed, cut to a length every disk takes; "artifact" when nothing is
 * left.
 */
export function exportName(title: string, extension: string): string {
  const base = title
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, NAME_MAX)
    .trim();
  return `${base || "artifact"}.${extension}`;
}
