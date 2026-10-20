import { describe, expect, it } from "vitest";

import { inHouseVoice, VOICE } from "./voice.js";

describe("the house voice", () => {
  it("is one section, short, and carries no em dash of its own", () => {
    expect(VOICE.startsWith("## Voice\n")).toBe(true);
    expect(VOICE).not.toContain("—");
    expect(VOICE.split("\n").length).toBeLessThan(12);
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
