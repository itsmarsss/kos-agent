import { describe, expect, it } from "vitest";

import { runningTail } from "./runningturn.js";

const you = (text = "") => ({ kind: "message", role: "you", text });
const kos = { kind: "message", role: "kos" };
const tool = { kind: "tool" };

describe("the running turn's steps in a transcript", () => {
  it("start after the words that opened the turn, the words heard after a step with them", () => {
    expect(runningTail([you(), kos, you("go"), tool, you("and this"), tool])).toBe(3);
  });

  it("are none when the turn has taken no step", () => {
    expect(runningTail([you(), kos, you("go")])).toBe(3);
    expect(runningTail([])).toBe(0);
  });

  it("are a turn KOS started on no words of the owner's", () => {
    expect(runningTail([you(), kos, tool, { kind: "reasoning" }])).toBe(2);
  });

  it("start after a line where the chat was cleared, and from the start of a chat with no answer yet", () => {
    expect(runningTail([you(), tool, { kind: "divider" }, tool])).toBe(3);
    expect(runningTail([you("first"), tool])).toBe(1);
  });
});
