/**
 * References, as links, for a surface that cannot draw a chip.
 *
 * The dashboard renders `@page:book_crm_home` and `@schedule:[Email Amy
 * Reminder]` as chips that open the thing. Discord shows the raw token,
 * which reads as a typo. A bot may send masked links, so each token becomes
 * one, pointing at the same place the chip would: the dashboard route for
 * that kind. Without a base URL the token is still tidied to its name.
 *
 * The pattern is the dashboard's own, so the two agree on what a reference
 * is. Code is left alone: a token inside backticks is being quoted, not used.
 */

import { pathsIn } from "@kos/shared";

const MENTION =
  /@(project|page|file|schedule|chat|site|blob|agent|approval):(?:\[([^\]]+)\]|([A-Za-z0-9._/-]*(?::[A-Za-z0-9._/-]+)*[A-Za-z0-9_/-]))/g;

/** Fenced blocks and inline code, which are not rewritten. */
const CODE = /(```[\s\S]*?```|`[^`\n]*`)/g;

/** The text with `rewrite` applied to every part that is not code; code is quoted, not used. */
export function outsideCode(text: string, rewrite: (part: string) => string): string {
  return text
    .split(CODE)
    .map((part, i) => (i % 2 === 1 ? part : rewrite(part)))
    .join("");
}

/** Where a reference goes on the dashboard, mirroring the chip's own href. */
export function mentionRoute(kind: string, id: string): string {
  const enc = encodeURIComponent;
  switch (kind) {
    case "page":
      return `#/page/${enc(id)}`;
    case "file":
      return `#/files/${enc(id)}`;
    case "schedule":
      return `#/schedule/${enc(id)}`;
    case "chat":
      return `#/chats/${enc(id)}`;
    case "blob":
    case "agent":
      return `#/blobs/${enc(id)}`;
    case "build":
      return `#/builds/${enc(id)}`;
    case "approval":
      return `#/inbox/${enc(id)}`;
    case "site":
      return `#/files/${enc(`projects/${id.replace("/", "/sites/")}`)}`;
    case "project":
      return `#/project/${enc(id)}`;
    default:
      return "#/projects";
  }
}

/**
 * The text with every reference tidied to its name and nothing more, for a
 * place that renders no markdown at all: an embed's title or footer, where
 * a masked link would show as its own brackets.
 */
export function plainMentions(text: string): string {
  return outsideCode(text, (part) => part.replace(MENTION, (_whole, _kind: string, bracketed?: string, plain?: string) => bracketed ?? plain ?? ""));
}

/**
 * The text with every workspace path turned into a link to the file on the
 * dashboard, for a step line ("Read blobs/verity/blob.md") so the file it
 * names can be opened from where the step is read.
 */
export function linkPaths(text: string, dashboardUrl?: string): string {
  const base = dashboardUrl?.replace(/\/+$/, "");
  if (!base) return text;
  return outsideCode(text, (part) =>
    pathsIn(part)
      .map((run) => (run.path ? `[${run.path}](<${base}/${mentionRoute("file", run.path)}>)` : run.text))
      .join(""),
  );
}

/** What to call a reference on a surface that cannot look it up: a title for an id, when known. */
export type LabelOf = (kind: string, id: string) => string | undefined;

/** The text with every reference turned into a link, or a plain name when there is nowhere to link to. */
export function linkMentions(text: string, dashboardUrl?: string, labelOf?: LabelOf): string {
  const base = dashboardUrl?.replace(/\/+$/, "");
  return outsideCode(text, (part) =>
    part.replace(MENTION, (_whole, kind: string, bracketed?: string, plain?: string) => {
      const id = bracketed ?? plain ?? "";
      // Brackets in a label would end the link early. A chat's id or a job's
      // number is no name for a link; the kernel's label for it is.
      const label = (labelOf?.(kind, id) ?? id).replace(/[[\]]/g, "");
      return base ? `[${label}](${base}/${mentionRoute(kind, id)})` : `**${label}**`;
    }),
  );
}
