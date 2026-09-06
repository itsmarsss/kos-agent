import { decodeAttributedBody } from "./attributedbody.js";
import { openReadOnlyDatabase } from "../store/db.js";
import type { Db } from "../store/db.js";

/**
 * Reading one iMessage thread, and only one.
 *
 * chat.db is the whole of Messages: on the machine this was written against,
 * 154,063 messages across 379 handles -- every conversation the owner has
 * ever had, with everyone. KOS is confined to the workspace, and a reader
 * that could see all of that would be the largest hole in that rule by far.
 *
 * So the scope is the query, not a filter applied afterwards. Every read is
 * bound to one conversation, passed as a parameter, and there is no code path
 * that builds a statement without it. Nothing else in the file is reachable:
 * not by a bug in the caller, and not by an agent that talks its way into
 * calling this, because the SQL it would reach cannot express the question.
 *
 * The conversation is the owner's own -- the note-to-self thread -- so what
 * KOS can see is what the owner deliberately sent to themselves.
 *
 * Scoped by chat rather than by handle, which matters: a message the owner
 * sends to themselves is recorded with handle_id 0, so joining through handle
 * silently dropped a third of the thread while looking like it worked.
 */

/** A message from the watched thread. Text only; attachments are not read. */
export interface ThreadMessage {
  /** message.ROWID, which is the watermark. Monotonic, so it orders reads. */
  rowId: number;
  text: string;
  /** True when the owner's account sent it, which in a self-thread is always. */
  fromMe: boolean;
  /** Apple epoch converted to a unix millisecond timestamp. */
  at: number;
}

/**
 * Apple stores message dates as nanoseconds since 2001-01-01, not the unix
 * epoch. Read as unix seconds a message reads as 1970 and every ordering by
 * time silently inverts against anything else in the workspace.
 */
const APPLE_EPOCH_OFFSET_MS = 978_307_200_000;

function toUnixMs(appleDate: number): number {
  // Older rows are in seconds, newer ones in nanoseconds. The magnitude is
  // the only thing that distinguishes them.
  const seconds = appleDate > 1e11 ? appleDate / 1e9 : appleDate;
  return Math.round(seconds * 1000 + APPLE_EPOCH_OFFSET_MS);
}

export interface ThreadReaderOptions {
  /** The one conversation this reader may ever see, by chat identifier. */
  handle: string;
  /** Path to chat.db. Injected so a test never opens the real one. */
  path: string;
}

export class ThreadReader {
  private readonly db: Db;
  private readonly handle: string;

  constructor(options: ThreadReaderOptions) {
    if (!options.handle.trim()) {
      // An empty handle would make the WHERE clause match nothing, which is
      // the safe direction, but it means the adapter is misconfigured and
      // silently deaf. Say so instead.
      throw new Error("iMessage reader needs the handle it is allowed to read");
    }
    this.handle = options.handle.trim();
    this.db = openReadOnlyDatabase(options.path);
  }

  /**
   * Where to start, so history is never replayed.
   *
   * Called once at startup. Everything already in the thread stays unread:
   * KOS waking up is not a reason to answer a message from last week.
   */
  watermark(): number {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(ROWID), 0) AS top FROM message`)
      .get() as { top: number };
    return row.top;
  }

  /**
   * Messages in the watched thread newer than `after`.
   *
   * The join to handle is what does the confining: a message reaches the
   * result only if its handle is the one this reader was built with.
   */
  since(after: number, limit = 50): ThreadMessage[] {
    const rows = this.db
      .prepare(
        `SELECT m.ROWID AS rowId, m.text AS text, m.attributedBody AS body,
                m.is_from_me AS fromMe, m.date AS date
         FROM message m
         JOIN chat_message_join j ON j.message_id = m.ROWID
         JOIN chat c ON c.ROWID = j.chat_id
         WHERE c.chat_identifier = ? AND m.ROWID > ?
         ORDER BY m.ROWID
         LIMIT ?`,
      )
      .all(this.handle, after, limit) as {
      rowId: number;
      text: string | null;
      body: Buffer | null;
      fromMe: number;
      date: number;
    }[];
    return rows
      .map((r) => ({
        rowId: r.rowId,
        // text first where it is there, because it needs no guessing.
        text: r.text?.trim() ? r.text : (decodeAttributedBody(r.body) ?? ""),
        fromMe: r.fromMe === 1,
        at: toUnixMs(r.date),
      }))
      // A reaction, an attachment with no caption and a few other things
      // carry no words at all. Answering one is answering nothing.
      .filter((m) => m.text.trim().length > 0);
  }

  close(): void {
    this.db.close();
  }
}
