import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
const A_THIRD_PERSON = "friend@example.com";

/** 2024-01-01 in Apple's epoch, in nanoseconds. */
const SOME_DATE = 725_846_400 * 1e9;

describe("reading one iMessage thread", () => {
  let root: string;
  let path: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-imsg-"));
    path = join(root, "chat.db");
    const db = new Database(path);
    db.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY,
        text TEXT,
        handle_id INTEGER,
        is_from_me INTEGER,
        date INTEGER
      );
    `);
    const handle = db.prepare(`INSERT INTO handle (ROWID, id) VALUES (?, ?)`);
    handle.run(1, OWNER);
    handle.run(2, SOMEONE_ELSE);
    handle.run(3, A_THIRD_PERSON);

    const msg = db.prepare(
      `INSERT INTO message (ROWID, text, handle_id, is_from_me, date)
       VALUES (?, ?, ?, ?, ?)`,
    );
    // Other people's conversations, interleaved with the owner's own thread
    // exactly as they would be in a real database.
    msg.run(1, "private thing said to a friend", 2, 0, SOME_DATE);
    msg.run(2, "note to self one", 1, 1, SOME_DATE);
    msg.run(3, "something from the third person", 3, 0, SOME_DATE);
    msg.run(4, "note to self two", 1, 1, SOME_DATE);
    msg.run(5, "a reply to the friend", 2, 1, SOME_DATE);
    msg.run(6, "", 1, 1, SOME_DATE);
    msg.run(7, null, 1, 1, SOME_DATE);
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
      "note to self one",
      "note to self two",
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
    expect(everything).not.toContain("third person");
    expect(everything).not.toContain("a reply to the friend");
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

    const db = new Database(path);
    db.prepare(
      `INSERT INTO message (ROWID, text, handle_id, is_from_me, date)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(8, "something new", 1, 1, SOME_DATE);
    // ...and something new from someone else, which must stay invisible.
    db.prepare(
      `INSERT INTO message (ROWID, text, handle_id, is_from_me, date)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(9, "new message from a friend", 2, 0, SOME_DATE);
    db.close();

    const fresh = reader.since(mark);
    reader.close();
    expect(fresh.map((m) => m.text)).toEqual(["something new"]);
  });

  it("skips rows with no text rather than sending empty turns", () => {
    // A reaction, an attachment with no caption, and a few other things all
    // arrive as a row with null text. Answering one is answering nothing.
    const reader = new ThreadReader({ handle: OWNER, path });
    const seen = reader.since(0);
    reader.close();
    expect(seen.every((m) => m.text.length > 0)).toBe(true);
  });

  it("reads Apple's epoch as a real date", () => {
    // Stored as nanoseconds since 2001. Read as unix seconds every message
    // dates to 1970 and sorts before everything else in the workspace.
    const reader = new ThreadReader({ handle: OWNER, path });
    const [first] = reader.since(0);
    reader.close();
    expect(new Date(first!.at).getUTCFullYear()).toBe(2024);
  });

  it("refuses to be built without a handle to confine it to", () => {
    // An empty handle matches nothing, which is safe but silently deaf.
    expect(() => new ThreadReader({ handle: "  ", path })).toThrow(/handle/);
  });
});
