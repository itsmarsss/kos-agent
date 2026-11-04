import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { priorForSdk } from "../chat/sdkchat.js";
import type { ModelMessage } from "../models/types.js";
import { BIG_CHARS, FIRST_CHUNK, HUGE_CHARS, ResultShelf, handleIn, shelveHistory } from "./shelf.js";

/**
 * A big result is read once and then set aside: whole for its turn and the
 * next, a stub after, the whole a recall away. The stub is written once, so
 * the history changes once per result and the cached front holds still.
 */

const shelf = (outlines: string[] = []): ResultShelf => {
  let asked = 0;
  return new ResultShelf(join(mkdtempSync(join(tmpdir(), "kos-shelf-")), "results"), async () => outlines[asked++] ?? `outline ${asked}`);
};
const doc = (n: number, fact = ""): string => `${fact} ${"routine operating detail. ".repeat(Math.ceil(n / 26))}`.slice(0, n);
const owner = (text: string): ModelMessage => ({ role: "user", content: [{ type: "text", text }] });
const called = (id: string): ModelMessage => ({ role: "assistant", content: [{ type: "tool_use", id, name: "files.read", input: { path: "review.pdf" } }] });
const result = (id: string, content: string): ModelMessage => ({ role: "user", content: [{ type: "tool_result", toolUseId: id, content, isError: false }] });
const said = (text: string): ModelMessage => ({ role: "assistant", content: [{ type: "text", text }] });
const contents = (h: ModelMessage[]): string[] => h.flatMap((m) => m.content.flatMap((b) => (b.type === "tool_result" ? [b.content] : [])));

describe("the shelf for big results", () => {
  it("passes small results through untouched and keeps big ones with their handle", async () => {
    const s = shelf();
    expect(await s.keep("files.read", { path: "a.txt" }, "short")).toBe("short");
    const kept = await s.keep("files.read", { path: "review.pdf" }, doc(BIG_CHARS + 100));
    const handle = handleIn(kept)!;
    expect(kept.startsWith(doc(BIG_CHARS + 100))).toBe(true);
    expect(kept).toContain(`context.recall with handle "${handle}"`);
    expect(s.get(handle)?.from).toBe("review.pdf");
  });

  it("gives a huge result in one SDK query as its start, an outline and the handle", async () => {
    const kept = await shelf(["Sections 1 to 30; Q3 churn in 9."]).keep("files.read", { path: "review.pdf" }, doc(HUGE_CHARS + 5000), { huge: true });
    expect(kept.length).toBeLessThan(FIRST_CHUNK + 800);
    expect(kept).toContain("Outline of the whole: Sections 1 to 30; Q3 churn in 9.");
    expect(handleIn(kept)).toMatch(/^r_/);
  });

  it("recalls the passages around a search, and a range", async () => {
    const s = shelf();
    const text = `${doc(40_000)} Q3 churn was 3.8 percent. ${doc(20_000)}`;
    const handle = handleIn(await s.keep("files.read", { path: "review.pdf" }, text))!;
    expect(s.recall(handle, { search: "churn" })).toContain("Q3 churn was 3.8 percent.");
    expect(s.recall(handle, { from: 0, to: 100 })).toContain("[characters 0 to 100 of");
    expect(s.recall("r_nothere1", {})).toContain("no kept result");
  });

  it("keeps a result whole for its turn and the next, then stubs every one due at once, the same way each time", async () => {
    const s = shelf();
    const a = await s.keep("files.read", { path: "review.pdf" }, doc(BIG_CHARS + 1, "Lisbon office has 42 staff."));
    const b = await s.keep("http.fetch", { url: "https://example.com/long" }, doc(BIG_CHARS + 1));
    // Turn 1 read both. Answering turn 2 they are whole.
    const t1 = [owner("read them"), called("1"), result("1", a), called("2"), result("2", b), said("done")];
    expect(contents(await shelveHistory(t1, s))).toEqual([a, b]);
    // Answering turn 3 both are stubs, set aside together.
    const t2 = [...t1, owner("what about Lisbon?"), said("42 staff")];
    const once = contents(await shelveHistory(t2, s));
    expect(once.every((c) => c.startsWith("[Set aside: "))).toBe(true);
    expect(once[0]).toContain("review.pdf");
    // Asked again, the stubs are the same words: the front of the prompt does not move.
    const t3 = [...t2, owner("and churn?"), said("3.8")];
    expect(contents(await shelveHistory(t3, s))).toEqual(once);
  });

  it("carries a kept result to the SDK in words, so a follow-up need not read it again", async () => {
    const s = shelf();
    const kept = await s.keep("files.read", { path: "review.pdf" }, doc(BIG_CHARS + 1, "Lisbon office has 42 staff."));
    const prompt = priorForSdk([owner("read it"), called("1"), result("1", kept), said("read")], "Lisbon?");
    expect(prompt).toContain("Lisbon office has 42 staff.");
    const later = priorForSdk(await shelveHistory([owner("read it"), called("1"), result("1", kept), said("read"), owner("ok"), said("ok")], s), "Lisbon?");
    expect(later).toContain("[Set aside: the files.read result from review.pdf");
    expect(later).not.toContain("routine operating detail. routine operating detail. routine");
  });
});
