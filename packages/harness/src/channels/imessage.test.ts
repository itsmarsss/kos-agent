import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  IMessageAdapter,
  parseDecision,
  renderForText,
} from "./imessage.js";
import type { InboundMessage } from "./types.js";

const OWNER = "+15550001111";
const SOMEONE_ELSE = "+15559998888";
const SOME_DATE = 725_846_400 * 1e9;

describe("rendering for a surface with no furniture", () => {
  it("lays a card out as lines", () => {
    const text = renderForText({
      text: "Noon nudge",
      card: {
        title: "Book CRM",
        body: "Nothing being read.",
        fields: [{ name: "Pipeline", value: "lead 3 · queued 2" }],
        footer: "No reading logged in the last 7 days",
      },
    });
    expect(text).toContain("Noon nudge");
    expect(text).toContain("Book CRM");
    expect(text).toContain("Pipeline: lead 3 · queued 2");
    expect(text).toContain("No reading logged");
  });

  it("lists buttons rather than dropping them", () => {
    /*
     * There is nothing to press. Saying what was on offer lets the owner
     * answer in words; omitting it silently would make the agent look like
     * it had said less than it did.
     */
    const text = renderForText({
      text: "What next?",
      buttons: [
        { id: "log", label: "Log progress" },
        { id: "add", label: "Add a book" },
      ],
    });
    expect(text).toContain('"Log progress"');
    expect(text).toContain('"Add a book"');
  });

  it("uses the unnamed field's value alone", () => {
    // Discord needs a zero-width name to render a bare block. Printed here it
    // would be a stray colon at the start of the line.
    const text = renderForText({
      text: "",
      card: { fields: [{ name: "​", value: "just the value" }] },
    });
    expect(text).toBe("just the value");
  });
});

describe("reading an owner's answer to a prompt", () => {
  it("takes the words a person would actually type", () => {
    expect(parseDecision("approve 12")).toEqual({ id: "12", approved: true });
    expect(parseDecision("  YES #12 ")).toEqual({ id: "12", approved: true });
    expect(parseDecision("deny 3")).toEqual({ id: "3", approved: false });
    expect(parseDecision("no 3")).toEqual({ id: "3", approved: false });
  });

  it("is not fooled by a sentence that merely mentions approving", () => {
    expect(parseDecision("should I approve 12 or not")).toBeNull();
    expect(parseDecision("approve everything")).toBeNull();
    expect(parseDecision("12")).toBeNull();
  });
});

describe("the iMessage adapter", () => {
  let root: string;
  let path: string;
  let sent: string[];
  let adapter: IMessageAdapter;

  /** chatId 1 is the owner's own thread; 2 belongs to somebody else. */
  function addMessage(rowId: number, text: string, chatId = 1): void {
    const db = new Database(path);
    db.prepare(
      `INSERT INTO message (ROWID, text, handle_id, is_from_me, date)
       VALUES (?, ?, 0, 1, ?)`,
    ).run(rowId, text, SOME_DATE);
    db.prepare(
      `INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)`,
    ).run(chatId, rowId);
    db.close();
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-imsg-a-"));
    path = join(root, "chat.db");
    const db = new Database(path);
    db.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT);
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY, text TEXT, attributedBody BLOB,
        handle_id INTEGER, is_from_me INTEGER, date INTEGER
      );
      INSERT INTO handle (ROWID, id) VALUES (1, '${OWNER}'), (2, '${SOMEONE_ELSE}');
      INSERT INTO chat (ROWID, chat_identifier)
        VALUES (1, '${OWNER}'), (2, '${SOMEONE_ELSE}');
      INSERT INTO message (ROWID, text, handle_id, is_from_me, date)
        VALUES (1, 'old news', 0, 1, ${SOME_DATE});
      INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 1);
    `);
    db.close();
    sent = [];
    adapter = new IMessageAdapter({
      handle: OWNER,
      dbPath: path,
      sender: async (_h, text) => {
        sent.push(text);
      },
    });
  });

  afterEach(async () => {
    await adapter.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it("delivers what the owner said after it started", async () => {
    const seen: InboundMessage[] = [];
    adapter.onMessage((m) => {
      seen.push(m);
    });
    await adapter.start();
    addMessage(2, "what is on today");
    await adapter.poll();

    expect(seen.map((m) => m.text)).toEqual(["what is on today"]);
    // "old news" predates the start and is never answered.
    expect(seen.map((m) => m.text)).not.toContain("old news");
  });

  it("does not read its own reply back as a new message", async () => {
    /*
     * The reply is sent into the same thread it is read from. Without echo
     * suppression the adapter answers itself, and then answers that, and the
     * loop only stops when someone notices.
     */
    const seen: InboundMessage[] = [];
    adapter.onMessage((m) => {
      seen.push(m);
    });
    await adapter.start();

    await adapter.send(OWNER, { text: "Here is your nudge." });
    addMessage(2, "Here is your nudge."); // as Messages records it
    await adapter.poll();

    expect(seen).toEqual([]);
  });

  it("hears the owner even when they say the same words back", async () => {
    // Suppression consumes one echo rather than muting a phrase forever.
    const seen: InboundMessage[] = [];
    adapter.onMessage((m) => {
      seen.push(m);
    });
    await adapter.start();

    await adapter.send(OWNER, { text: "ping" });
    addMessage(2, "ping");
    await adapter.poll();
    expect(seen).toEqual([]);

    addMessage(3, "ping");
    await adapter.poll();
    expect(seen.map((m) => m.text)).toEqual(["ping"]);
  });

  it("turns an answer to a prompt into a decision, not a message", async () => {
    const seen: InboundMessage[] = [];
    const decisions: { id: string; approved: boolean }[] = [];
    adapter.onMessage((m) => {
      seen.push(m);
    });
    adapter.onApproval((d) => {
      decisions.push({ id: d.id, approved: d.approved });
    });
    await adapter.start();

    await adapter.requestApproval(OWNER, { id: "12", text: "Delete notes.txt?" });
    expect(sent.at(-1)).toContain('Reply "approve 12" or "deny 12"');

    addMessage(2, "approve 12");
    await adapter.poll();

    expect(decisions).toEqual([{ id: "12", approved: true }]);
    expect(seen).toEqual([]);
  });

  it("treats an answer to nothing as an ordinary message", async () => {
    // "approve 12" with no prompt outstanding is the owner talking, and
    // silently swallowing it would be a message that vanished.
    const seen: InboundMessage[] = [];
    adapter.onMessage((m) => {
      seen.push(m);
    });
    await adapter.start();
    addMessage(2, "approve 12");
    await adapter.poll();

    expect(seen.map((m) => m.text)).toEqual(["approve 12"]);
  });

  it("never delivers a message from another conversation", async () => {
    const seen: InboundMessage[] = [];
    adapter.onMessage((m) => {
      seen.push(m);
    });
    await adapter.start();
    addMessage(2, "a message from a friend", 2);
    await adapter.poll();

    expect(seen).toEqual([]);
  });

  it("stops polling once stopped", async () => {
    const seen: InboundMessage[] = [];
    adapter.onMessage((m) => {
      seen.push(m);
    });
    await adapter.start();
    await adapter.stop();
    addMessage(2, "after the end");
    await adapter.poll();

    expect(seen).toEqual([]);
  });
});
