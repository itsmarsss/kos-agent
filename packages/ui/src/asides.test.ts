import { describe, expect, it } from "vitest";

import type { PendingMessage } from "./api.js";
import { retireAsides, waitingAsides, waitingRows, type Aside } from "./asides.js";
import type { Live } from "./progress.js";

const aside = (key: number, text: string, more: Partial<Aside> = {}): Aside => ({ key, conversationId: "c1", text, attachments: [], at: 100, before: [], steps: 0, ...more });
const row = (id: number, text: string): PendingMessage => ({ id, text, attachments: [] });
const live = (more: Partial<Live>): Live => ({ steps: [], text: "", since: 50, ...more });
const tool = { kind: "tool" as const, tool: "browser.act", summary: "Click", done: true, isError: false };

describe("a message sent mid-turn, until the server has it", () => {
  it("becomes its row once a fetch has the row, and stays gone when the row is edited or dropped", () => {
    const sent = [aside(1, "skip the ebooks")];
    const retired = retireAsides(sent, "c1", [row(7, "skip the ebooks")]);
    expect(retired).toEqual([]);
    // Edited or dropped later, the row is what changes; nothing brings the aside back.
    expect(retireAsides(retired, "c1", [row(7, "skip the ebooks, and the audiobooks")])).toEqual([]);
    expect(retireAsides(retired, "c1", [])).toEqual([]);
  });

  it("is not a row that was already waiting when it was sent, nor another chat's", () => {
    const sent = [aside(1, "yes", { before: [3] })];
    expect(retireAsides(sent, "c1", [row(3, "yes")])).toEqual(sent);
    expect(retireAsides(sent, "c2", [row(9, "yes")])).toEqual(sent);
  });

  it("takes one row each when the same words were sent twice", () => {
    const sent = [aside(1, "yes"), aside(2, "yes")];
    expect(retireAsides(sent, "c1", [row(7, "yes")])).toEqual([sent[1]]);
    expect(retireAsides(sent, "c1", [row(7, "yes"), row(8, "yes")])).toEqual([]);
  });

  it("leaves the queue once the turn hears it, one heard step for each", () => {
    const sent = [aside(1, "yes", { turn: 50, steps: 1 }), aside(2, "yes", { turn: 50, steps: 1 })];
    const heardOnce = live({ steps: [tool, { kind: "said", text: "yes" }] });
    expect(waitingAsides(sent, "c1", heardOnce)).toEqual([sent[1]]);
    // A step heard before it was sent is some other message.
    expect(waitingAsides(sent, "c1", live({ steps: [{ kind: "said", text: "yes" }, tool] }))).toEqual(sent);
  });

  it("leaves the queue once a turn of its own starts with it, and still when that turn has ended", () => {
    const sent = [aside(1, "and the red one", { turn: 50, steps: 2 })];
    expect(waitingAsides(sent, "c1", live({ since: 200, said: "and the red one", pendingId: 9 }))).toEqual([]);
    expect(waitingAsides(sent, "c1", live({ since: 200, said: "and the red one", pendingId: 9, ended: true }))).toEqual([]);
    // A turn that started before it was sent did not start with it.
    expect(waitingAsides(sent, "c1", live({ since: 50, said: "and the red one", pendingId: 9 }))).toEqual(sent);
    // Nor did a turn the owner started directly, which waited as no row.
    expect(waitingAsides(sent, "c1", live({ since: 200, said: "and the red one" }))).toEqual(sent);
  });

  it("is not a row that was already waiting when it was sent, heard or run", () => {
    const sent = [aside(1, "ok", { before: [4], turn: 50, steps: 0 })];
    expect(waitingAsides(sent, "c1", live({ steps: [{ kind: "said", text: "ok", pendingId: 4 }] }))).toEqual(sent);
    expect(waitingAsides(sent, "c1", live({ since: 200, said: "ok", pendingId: 4 }))).toEqual(sent);
  });
});

describe("the waiting rows shown under a turn", () => {
  it("leaves out a row the turn heard, by its id, and keeps another with the same words", () => {
    const rows = [row(7, "yes"), row(8, "yes")];
    expect(waitingRows(rows, live({ steps: [{ kind: "said", text: "yes", pendingId: 7 }] }))).toEqual([rows[1]]);
  });

  it("leaves out the row the turn runs, by its id, ended or not", () => {
    const rows = [row(7, "yes"), row(8, "yes")];
    expect(waitingRows(rows, live({ said: "yes", pendingId: 8 }))).toEqual([rows[0]]);
    expect(waitingRows(rows, live({ said: "yes", pendingId: 8, ended: true }))).toEqual([rows[0]]);
    expect(waitingRows(rows, undefined)).toEqual(rows);
  });

  it("keeps a row with the same words as a turn that waited as no row", () => {
    // The turn started with "ok" typed while idle; "ok" sent again mid-turn is really waiting.
    const rows = [row(7, "ok")];
    expect(waitingRows(rows, live({ said: "ok" }))).toEqual(rows);
  });
});
