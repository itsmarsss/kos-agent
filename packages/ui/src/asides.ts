import type { PendingMessage } from "./api.js";
import type { Live } from "./progress.js";

/**
 * Messages the owner sent while a turn ran in the chat.
 *
 * The server keeps such a message as a waiting row until the turn takes it
 * in at its next step, or runs it after. Until the page has fetched that row
 * the words would be on screen nowhere, so the page holds them as an aside:
 * under the running turn, waiting. Words are not identity ("yes" can be sent
 * twice), so each row, each heard step and each turn's opening words stands
 * for at most one aside, and only one sent before it.
 */
export interface Aside {
  key: number;
  conversationId: string;
  text: string;
  attachments: { name: string }[];
  /** When it was sent. */
  at: number;
  /** The rows already waiting then: none of them is this one. */
  before: number[];
  /** The live turn it was sent into, by when that turn started, and how many steps it had. */
  turn?: number;
  steps: number;
}

/**
 * The asides a fetch of the chat's waiting rows has not answered. A row new
 * since an aside was sent, with its words, is that aside from then on, for
 * good: edited or dropped as a row, it does not come back as an aside.
 */
export function retireAsides(asides: Aside[], conversationId: string, rows: PendingMessage[]): Aside[] {
  const claimed = new Set<number>();
  return asides.filter((a) => {
    if (a.conversationId !== conversationId) return true;
    const row = rows.find((r) => !claimed.has(r.id) && !a.before.includes(r.id) && r.text === a.text);
    if (!row) return true;
    claimed.add(row.id);
    return false;
  });
}

/** The chat's asides the live turn has not taken in, as heard words or as the words it started with. */
export function waitingAsides(asides: Aside[], conversationId: string, live: Live | undefined): Aside[] {
  const mine = asides.filter((a) => a.conversationId === conversationId);
  if (!live) return mine;
  const taken = new Set<Aside>();
  const take = (text: string, sentBefore: (a: Aside) => boolean): void => {
    const aside = mine.find((a) => !taken.has(a) && a.text === text && sentBefore(a));
    if (aside) taken.add(aside);
  };
  if (live.said) take(live.said, (a) => a.at <= live.since);
  live.steps.forEach((step, i) => {
    if (step.kind === "said") take(step.text, (a) => (a.turn === live.since ? i >= a.steps : a.at <= live.since));
  });
  return mine.filter((a) => !taken.has(a));
}

/**
 * The waiting rows still to show: not one the live turn heard, by its id,
 * nor the one its turn started with, which is on screen as its words.
 */
export function waitingRows(rows: PendingMessage[], live: Live | undefined): PendingMessage[] {
  if (!live) return rows;
  const heard = new Set(live.steps.flatMap((s) => (s.kind === "said" && s.pendingId !== undefined ? [s.pendingId] : [])));
  const started = live.said === undefined ? undefined : rows.find((r) => !heard.has(r.id) && r.text === live.said);
  return rows.filter((r) => !heard.has(r.id) && r !== started);
}
