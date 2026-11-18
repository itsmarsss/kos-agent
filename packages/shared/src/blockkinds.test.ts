import { describe, expect, it } from "vitest";

import { parseBlock, type KosBlock } from "./blocks.js";
import {
  BLOCK_KINDS,
  BLOCKS_GUIDANCE,
  blocksToText,
  checklistOf,
  copyOf,
  diffLineOf,
  icsOf,
  kindOf,
  mailtoOf,
  mapOf,
  plainOf,
  sendRequestOf,
  sendToolOf,
  sourceOf,
  stepsOf,
  viewOf,
} from "./blockkinds.js";

const block = (kind: string, text: string): KosBlock => {
  const b = parseBlock(`kos:${kind}`, text.split("\n"));
  if (!b) throw new Error("malformed");
  return b;
};

const email = block("email", "to: sam@example.com\nto: amy@example.com\ncc: lee@example.com\nsubject: Saturday at 4\n---\nHi Sam,\n\nStill on?");

describe("the registry", () => {
  it("knows each kind once, and draws an unknown one as a card under its own name", () => {
    expect(new Set(BLOCK_KINDS.map((k) => k.name)).size).toBe(BLOCK_KINDS.length);
    expect(kindOf("recipe")).toMatchObject({ name: "recipe", label: "Recipe", title: "title", body: "prose", actions: ["copy"] });
    expect(kindOf("follow-up").label).toBe("Follow up");
  });

  it("lays out the header: known fields in order, the rest after, no title or actions", () => {
    const view = viewOf(block("event", "where: Nopa\nwhen: 2026-11-21 19:00\ntitle: Dinner\nmood: fancy\naction: open https://nopa.com Menu\naction: rm -rf"));
    expect(view.title).toBe("Dinner");
    expect(view.rows).toEqual([
      { key: "when", label: "When", values: ["2026-11-21 19:00"] },
      { key: "where", label: "Where", values: ["Nopa"] },
      { key: "mood", label: "Mood", values: ["fancy"] },
    ]);
    // Only an open of a web address is an action; anything else is dropped.
    expect(view.links).toEqual([{ label: "Menu", href: "https://nopa.com" }]);
  });
});

describe("plain words", () => {
  it("says a block as its heading, its fields and its body", () => {
    expect(plainOf(email)).toBe("Draft email\nTo: sam@example.com, amy@example.com\nCc: lee@example.com\nSubject: Saturday at 4\n\nHi Sam,\n\nStill on?");
    expect(plainOf(block("card", "title: Plan\nbudget: $40\n---\nGo early."))).toBe("Plan\nBudget: $40\n\nGo early.");
    expect(plainOf(block("event", "title: Dinner\nwhen: Sat 7pm"))).toBe("Event: Dinner\nWhen: Sat 7pm");
  });

  it("replaces each block in a reply and leaves the rest, a malformed block included", () => {
    const reply = "Drafted:\n\n```kos:message\nto: Sam\n---\nRunning late\n```\n\n```kos:email\nnot a header\n```";
    expect(blocksToText(reply)).toBe("Drafted:\n\nDraft message\nTo: Sam\n\nRunning late\n\n```kos:email\nnot a header\n```");
  });

  it("copies a draft's body, and the whole of an event", () => {
    expect(copyOf(email)).toBe("Hi Sam,\n\nStill on?");
    expect(copyOf(block("event", "title: Dinner\nwhen: Sat"))).toBe("Event: Dinner\nWhen: Sat");
    expect(copyOf(block("email", "to: a@x.com"))).toBe("Draft email\nTo: a@x.com");
  });

  it("writes a block back as source that reads the same, with a longer fence round one inside", () => {
    expect(parseBlock("kos:email", sourceOf(email).split("\n").slice(1, -1))).toEqual(email);
    const nested = block("card", "title: Code\n---\n```ts\nx\n```");
    const source = sourceOf(nested);
    expect(source.startsWith("````kos:card\n")).toBe(true);
    expect(source.endsWith("\n````")).toBe(true);
  });
});

describe("actions", () => {
  it("opens a draft in the mail app with every field", () => {
    expect(mailtoOf(email)).toBe(
      "mailto:sam%40example.com,amy%40example.com?cc=lee%40example.com&subject=Saturday%20at%204&body=Hi%20Sam%2C%0A%0AStill%20on%3F",
    );
    expect(mailtoOf(block("email", "---\nhi"))).toBe("mailto:?body=hi");
  });

  it("finds a place on a map", () => {
    expect(mapOf(block("address", "name: Nopa\n---\n560 Divisadero St\nSan Francisco"))).toBe(
      "https://www.google.com/maps/search/?api=1&query=Nopa%2C%20560%20Divisadero%20St%2C%20San%20Francisco",
    );
    expect(mapOf(block("address", ""))).toBeUndefined();
  });

  it("offers Send only through a tool this KOS has, by kind and channel", () => {
    const tools = ["files.read", "notify", "mcp.gmail.send_email", "mcp.imessage.send_message"];
    expect(sendToolOf(email, tools)).toBe("mcp.gmail.send_email");
    expect(sendToolOf(email, ["notify"])).toBeUndefined();
    expect(sendToolOf(block("message", "channel: discord\n---\nhi"), tools)).toBe("notify");
    expect(sendToolOf(block("message", "channel: iMessage\n---\nhi"), tools)).toBe("mcp.imessage.send_message");
    expect(sendToolOf(block("message", "channel: sms\n---\nhi"), tools)).toBeUndefined();
    expect(sendToolOf(block("event", "title: x"), tools)).toBeUndefined();
  });

  it("asks KOS to send, quoting the draft exactly", () => {
    const ask = sendRequestOf(email, "mcp.gmail.send_email");
    expect(ask.startsWith("Send this email as drafted, with mcp.gmail.send_email.\n\n```kos:email\n")).toBe(true);
    expect(ask).toContain("subject: Saturday at 4\n---\nHi Sam,");
  });

  it("makes an .ics of a timed, an all-day and an undated event", () => {
    const now = new Date("2026-11-18T12:00:00Z");
    const timed = icsOf(block("event", "title: Dinner, late\nwhen: 2026-11-21 19:30\nwhere: Nopa; SF\n---\nBring wine"), now);
    expect(timed).toContain("DTSTART:20261121T193000\r\n");
    expect(timed).toContain("DTEND:20261121T203000\r\n");
    expect(timed).toContain("SUMMARY:Dinner\\, late\r\n");
    expect(timed).toContain("LOCATION:Nopa\\; SF\r\n");
    expect(timed).toContain("DESCRIPTION:Bring wine\r\n");
    expect(timed).toContain("DTSTAMP:20261118T120000Z\r\n");
    const allDay = icsOf(block("event", "title: Trip\nwhen: 2026-12-31\nend: 2027-01-02"), now);
    expect(allDay).toContain("DTSTART;VALUE=DATE:20261231\r\n");
    expect(allDay).toContain("DTEND;VALUE=DATE:20270102\r\n");
    expect(icsOf(block("event", "title: Party\nwhen: <t:2026-12-31T23:30:f>"), now)).toContain("DTEND:20270101T003000");
    expect(icsOf(block("event", "title: Soon\nwhen: next Saturday"), now)).toBeUndefined();
    expect(icsOf(email, now)).toBeUndefined();
  });

  it("folds a long iCalendar line", () => {
    const ics = icsOf(block("event", `title: ${"x".repeat(100)}\nwhen: 2026-11-21`)) ?? "";
    expect(ics.split("\r\n").every((l) => l.length <= 75)).toBe(true);
    expect(ics).toContain("\r\n x");
  });
});

describe("bodies", () => {
  it("reads checklist items and the lines between them", () => {
    expect(checklistOf("- [ ] milk\n- [x] eggs\n\nAt the shop:\n* [X] bread")).toEqual([
      { text: "milk", done: false },
      { text: "eggs", done: true },
      { text: "At the shop:" },
      { text: "bread", done: true },
    ]);
  });

  it("reads steps however they were numbered", () => {
    expect(stepsOf("1. Open\n2) Click\n- Done\nplain")).toEqual(["Open", "Click", "Done", "plain"]);
  });

  it("sorts diff lines", () => {
    expect(["@@ -1 +1 @@", "+a", "-b", " c", "+++ b/x", "--- a/x"].map(diffLineOf)).toEqual(["hunk", "add", "del", "same", "same", "same"]);
  });
});

describe("the prompt note", () => {
  it("names every kind in the table and shows the grammar", () => {
    for (const kind of BLOCK_KINDS) expect(BLOCKS_GUIDANCE).toContain(`kos:${kind.name}`);
    expect(BLOCKS_GUIDANCE).toContain("---");
    expect(BLOCKS_GUIDANCE).not.toMatch(/[—–]/);
  });
});
