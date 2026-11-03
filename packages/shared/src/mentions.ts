/**
 * What an @ can name, and how one is written: one list, read by the server
 * that resolves them, the box that offers them as you type, the box that
 * colours them, and the markdown that draws them.
 *
 * Three copies had grown, and a kind added to one (tab, approval) was a
 * plain word in the others until someone noticed.
 */

/** The kinds, in the order the autocomplete offers them. "agent" is what a blob was called first; it still reads as one. */
export const MENTION_KINDS = ["project", "page", "file", "schedule", "chat", "site", "blob", "agent", "build", "tab", "approval"] as const;

export type MentionKind = (typeof MENTION_KINDS)[number];

/**
 * A mention as a pattern's source: the kind, then the id either bracketed,
 * which may hold anything but a bracket, or plain. Groups: 1 the kind, 2 the
 * bracketed id, 3 the plain one. The bracketed branch is tried first so
 * "[a b]" is not read as the plain id "". A plain id may hold dots but not
 * end on one, or a mention finishing a sentence eats the full stop.
 */
export const MENTION_SOURCE = String.raw`@(${MENTION_KINDS.join("|")}):(?:\[([^\]]+)\]|([A-Za-z0-9._/-]*(?::[A-Za-z0-9._/-]+)*[A-Za-z0-9_/-]))`;
