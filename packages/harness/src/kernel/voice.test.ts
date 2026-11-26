import { describe, expect, it } from "vitest";

import { beforeReply, inHouseVoice, REPLY, replyLine, STUCK_REPLY, VOICE } from "./voice.js";

describe("the house voice", () => {
  it("is one section, short, and carries no em dash of its own", () => {
    expect(VOICE.startsWith("## Voice\n")).toBe(true);
    expect(VOICE).not.toContain("—");
    expect(VOICE.split("\n").length).toBeLessThan(12);
  });

  it("asks for a one-line reaction once the owner decides on an ask", () => {
    expect(VOICE).toContain("Once the owner decides on something you asked for, react in one line");
    expect(VOICE).toContain("A decided ask is never still waiting on them.");
    expect(VOICE).toContain("No recap of the ask or the approval.");
  });

  it("says the reply is only what follows the last call, and how short it is", () => {
    expect(REPLY.startsWith("## Your reply\n")).toBe(true);
    expect(REPLY).toContain("Only what you write after your last tool call is your reply");
    expect(REPLY).toContain("under about 600 characters");
    expect(REPLY).toContain("No recap of steps the owner can already see");
    expect(REPLY).toContain("no closing offer");
    expect(REPLY).toContain("the post is the result");
    expect(REPLY).not.toContain("—");
    // Model agnostic: no provider or model is named.
    expect(REPLY).not.toMatch(/claude|anthropic|openai|gpt|sonnet|haiku|opus/i);
  });

  it("keeps the length limit to the reply, not to what a post carries", () => {
    expect(REPLY).toContain("The limit is for your reply, not for what a post carries.");
  });

  it("gives a turn with no words a line of KOS's own, the same on both engines", () => {
    expect(replyLine("Done — sent.", { stopped: false, stuck: false })).toBe("Done, sent.");
    expect(replyLine("", { stopped: true, stuck: true })).toBe("Stopped.");
    // A step-capped or failed turn says it got stuck, not that it had nothing to add.
    expect(replyLine(" ", { stopped: false, stuck: true })).toBe(STUCK_REPLY);
    expect(replyLine("", { stopped: false, stuck: false })).toBe("I do not have anything to add to that.");
  });

  it("adds a section in front of the closing reply rule, and at the end of a prompt without one", () => {
    expect(beforeReply(`base\n\n${REPLY}`, "hand-on")).toBe(`base\n\nhand-on\n\n${REPLY}`);
    expect(beforeReply("base", "hand-on")).toBe("base\n\nhand-on");
  });

  it("rewrites an em dash as the pause it stood for, outside code", () => {
    expect(inHouseVoice("Done — the file is there.")).toBe("Done, the file is there.");
    expect(inHouseVoice("Done—the file is there.")).toBe("Done, the file is there.");
    expect(inHouseVoice("Two things, — both small.")).toBe("Two things, both small.");
    expect(inHouseVoice("Here is the list:\n— one\n— two")).toBe("Here is the list:\n- one\n- two");
    expect(inHouseVoice("It ran, then stopped —\nnothing after.")).toBe("It ran, then stopped.\nnothing after.");
    expect(inHouseVoice("Ran at 9 – 5 – done.")).toBe("Ran at 9, 5, done.");
  });

  it("leaves code, ranges and a dashless reply exactly alone", () => {
    expect(inHouseVoice("Run `a — b` then `--flag`.")).toBe("Run `a — b` then `--flag`.");
    const fenced = "Before — now.\n```\nx — y\n```\nAfter — later.";
    expect(inHouseVoice(fenced)).toBe("Before, now.\n```\nx — y\n```\nAfter, later.");
    expect(inHouseVoice("Open 9–5 on weekdays.")).toBe("Open 9–5 on weekdays.");
    const plain = "Nothing to change here - a hyphen is fine.";
    expect(inHouseVoice(plain)).toBe(plain);
  });
});
