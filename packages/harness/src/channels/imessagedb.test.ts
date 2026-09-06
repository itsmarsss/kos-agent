import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { typedstream } from "./imessage.fixture.js";
import { ThreadReader } from "./imessagedb.js";

/**
 * A stand-in for chat.db, holding the parts this reader touches.
 *
 * Deliberately populated with other people's conversations as well as the
 * owner's own thread, because the whole point of the reader is that those are
 * unreachable. A fixture with only the self-thread in it would pass whatever
 * the query said.
 */
const OWNER = "+15550001111";
const SOMEONE_ELSE = "+15559998888";

/** 2024-01-01 in Apple's epoch, in nanoseconds. */
const SOME_DATE = 725_846_400 * 1e9;

describe("reading one iMessage thread", () => {
  let root: string;
  let path: string;

  function open(): Database.Database {
    return new Database(path);
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-imsg-"));
    path = join(root, "chat.db");
    const db = open();
    db.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT);
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY,
        text TEXT,
        attributedBody BLOB,
        handle_id INTEGER,
        is_from_me INTEGER,
        date INTEGER
      );
      INSERT INTO handle (ROWID, id) VALUES (1, '${OWNER}'), (2, '${SOMEONE_ELSE}');
      INSERT INTO chat (ROWID, chat_identifier)
        VALUES (1, '${OWNER}'), (2, '${SOMEONE_ELSE}');
    `);

    const msg = db.prepare(
      `INSERT INTO message (ROWID, text, attributedBody, handle_id, is_from_me, date)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const link = db.prepare(
      `INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)`,
    );

    /*
     * Every message in a self-thread is stored twice: the sent copy, then the
     * copy that arrives back. The fixture says so, because reading both is
     * what made the surface answer itself.
     */
    // "note with plain text", sent then arrived.
    msg.run(1, null, typedstream("note with plain text"), 0, 1, SOME_DATE);
    link.run(1, 1);
    msg.run(2, "note with plain text", null, 1, 0, SOME_DATE);
    link.run(1, 2);
    // One whose arriving copy carries only attributedBody.
    msg.run(3, null, typedstream("note in attributedBody"), 0, 1, SOME_DATE);
    link.run(1, 3);
    msg.run(4, null, typedstream("note in attributedBody"), 1, 0, SOME_DATE);
    link.run(1, 4);
    // A tapback: a row with no words in it at all.
    msg.run(5, null, null, 1, 0, SOME_DATE);
    link.run(1, 5);

    // Somebody else's conversation, which must stay unreachable.
    msg.run(6, "private thing said to a friend", null, 2, 0, SOME_DATE);
    link.run(2, 6);
    msg.run(7, null, typedstream("another private thing"), 2, 0, SOME_DATE);
    link.run(2, 7);
    db.close();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns the owner's thread and nothing else", () => {
    const reader = new ThreadReader({ handle: OWNER, path });
    const seen = reader.since(0);
    reader.close();

    expect(seen.map((m) => m.text)).toEqual([
      "note with plain text",
      "note in attributedBody",
    ]);
  });

  it("cannot reach another conversation even when asked from the start", () => {
    /*
     * The confinement is the query, not a filter over its results. If this
     * ever fails, KOS can read the owner's messages with everyone.
     */
    const reader = new ThreadReader({ handle: OWNER, path });
    const everything = reader.since(0, 1000).map((m) => m.text).join(" ");
    reader.close();

    expect(everything).not.toContain("private thing");
    expect(everything).not.toContain("another private");
  });

  it("reports each message once, not once per stored copy", () => {
    /*
     * Both copies read, every message arrived twice. KOS's own replies came
     * back the same way, and the suppression list caught only one half, so
     * the surface answered itself until it was killed.
     */
    const reader = new ThreadReader({ handle: OWNER, path });
    const seen = reader.since(0).map((m) => m.text);
    reader.close();
    expect(seen.filter((t) => t === "note with plain text")).toHaveLength(1);
    expect(seen.filter((t) => t === "note in attributedBody")).toHaveLength(1);
  });

  it("reads a body that lives only in attributedBody", () => {
    // On a real database this was 111 of 112 messages: trusting `text` alone
    // sees almost nothing while appearing to work.
    const reader = new ThreadReader({ handle: OWNER, path });
    const seen = reader.since(0);
    reader.close();
    expect(seen.map((m) => m.text)).toContain("note in attributedBody");
  });

  it("skips rows with no words rather than sending empty turns", () => {
    const reader = new ThreadReader({ handle: OWNER, path });
    const seen = reader.since(0);
    reader.close();
    expect(seen.every((m) => m.text.trim().length > 0)).toBe(true);
  });

  it("starts from the end, so waking up does not answer old messages", () => {
    const reader = new ThreadReader({ handle: OWNER, path });
    const mark = reader.watermark();
    expect(reader.since(mark)).toEqual([]);
    reader.close();
  });

  it("picks up only what arrived after the watermark", () => {
    const reader = new ThreadReader({ handle: OWNER, path });
    const mark = reader.watermark();

    const db = open();
    db.prepare(
      `INSERT INTO message (ROWID, text, handle_id, is_from_me, date)
       VALUES (8, 'something new', 1, 0, ?)`,
    ).run(SOME_DATE);
    db.prepare(
      `INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 8)`,
    ).run();
    // ...and something new from someone else, which must stay invisible.
    db.prepare(
      `INSERT INTO message (ROWID, text, handle_id, is_from_me, date)
       VALUES (9, 'new message from a friend', 2, 0, ?)`,
    ).run(SOME_DATE);
    db.prepare(
      `INSERT INTO chat_message_join (chat_id, message_id) VALUES (2, 9)`,
    ).run();
    db.close();

    const fresh = reader.since(mark);
    reader.close();
    expect(fresh.map((m) => m.text)).toEqual(["something new"]);
  });

  it("reads Apple's epoch as a real date", () => {
    // Stored as nanoseconds since 2001. Read as unix seconds every message
    // dates to 1970 and sorts before everything else in the workspace.
    const reader = new ThreadReader({ handle: OWNER, path });
    const [first] = reader.since(0);
    reader.close();
    expect(new Date(first!.at).getUTCFullYear()).toBe(2024);
  });

  it("refuses to be built without a conversation to confine it to", () => {
    expect(() => new ThreadReader({ handle: "  ", path })).toThrow(/conversation|handle/);
  });
});
