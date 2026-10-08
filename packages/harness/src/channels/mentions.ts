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

const MENTION =
  /@(project|page|file|schedule|chat|site|agent):(?:\[([^\]]+)\]|([A-Za-z0-9._/-]*[A-Za-z0-9_/-]))/g;

/** Fenced blocks and inline code, which are not rewritten. */
const CODE = /(```[\s\S]*?```|`[^`\n]*`)/g;

/** Where a reference goes on the dashboard, mirroring the chip's own href. */
export function mentionRoute(kind: string, id: string): string {
  const enc = encodeURIComponent;
  switch (kind) {
    case "page":
      return `#/page/${enc(id)}`;
    case "file":
      return `#/files/${enc(id)}`;
    case "schedule":
      return "#/schedule";
    case "chat":
      return `#/chats/${enc(id)}`;
    case "agent":
      return `#/agents/${enc(id)}`;
    case "site":
      return `#/files/${enc(`projects/${id.replace("/", "/sites/")}`)}`;
    case "project":
      return `#/project/${enc(id)}`;
    default:
      return "#/projects";
  }
}

/** The text with every reference turned into a link, or a plain name when there is nowhere to link to. */
export function linkMentions(text: string, dashboardUrl?: string): string {
  const base = dashboardUrl?.replace(/\/+$/, "");
  return text
    .split(CODE)
    .map((part, i) => {
      // Odd parts are the code captures; they pass through untouched.
      if (i % 2 === 1) return part;
      return part.replace(MENTION, (_whole, kind: string, bracketed?: string, plain?: string) => {
        const id = bracketed ?? plain ?? "";
        // Brackets in a label would end the link early.
        const label = id.replace(/[[\]]/g, "");
        return base ? `[${label}](${base}/${mentionRoute(kind, id)})` : `**${label}**`;
      });
    })
    .join("");
}
