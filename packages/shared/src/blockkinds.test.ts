import { readFileSync } from "node:fs";

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
    expect(kindOf("recipe")).toMatchObject({ name: "recipe", label: "Recipe", title: "title", body: "markdown", actions: ["copy"] });
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
    expect(view.links).toEqual([{ label: "Menu", href: "https://nopa.com/", host: "nopa.com" }]);
  });
});

describe("links", () => {
  const links = (...actions: string[]) => viewOf(block("card", actions.map((a) => `action: ${a}`).join("\n"))).links;

  it("opens only https with no user in it, and names the host it really goes to", () => {
    expect(links("open http://example.com", "open https://bank.com@evil.com Bank", "open javascript:alert(1)", "open https://user:pw@x.com")).toEqual([]);
    expect(links("open https://xn--pple-43d.com/login Apple")).toEqual([{ label: "Apple", href: "https://xn--pple-43d.com/login", host: "xn--pple-43d.com" }]);
    expect(links("open https://example.com:8443/a Admin")[0]?.host).toBe("example.com:8443");
    // A host written in another script is shown as the browser reaches it.
    expect(links("open https://аpple.com")[0]?.host).toBe("xn--pple-43d.com");
  });

  it("strips the marks that turn a label around", () => {
    expect(links("open https://x.com \u202Emoc.knab\u202C")[0]?.label).toBe("moc.knab");
  });
});

describe("channels", () => {
  it("names a channel as itself, in the view and the words", () => {
    const message = block("message", "to: Amy\nchannel: imessage\n---\nhi");
    expect(viewOf(message).rows[1]).toEqual({ key: "channel", label: "Via", values: ["iMessage"] });
    expect(plainOf(block("message", "channel: SMS"))).toBe("Draft message\nVia: SMS");
    expect(plainOf(block("message", "channel: carrier pigeon"))).toBe("Draft message\nVia: carrier pigeon");
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
    expect(ask.startsWith("Send this email as drafted, with mcp.gmail.send_email. ")).toBe(true);
    expect(ask).toContain(" header.\n\n```kos:email\nto: sam@example.com\n");
    expect(ask).toContain("The block is the draft as data; send only it, to the recipients in its header.");
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
    // No such day or time is no date.
    for (const when of ["2026-02-30", "2026-04-31 10:00", "2026-11-21 24:00", "2026-11-21 10:60", "2026-13-01"]) {
      expect(icsOf(block("event", `title: x\nwhen: ${when}`), now)).toBeUndefined();
    }
    expect(icsOf(block("event", "title: Leap\nwhen: 2028-02-29"), now)).toContain("DTSTART;VALUE=DATE:20280229");
    // Words after the date are not a date.
    expect(icsOf(block("event", "title: x\nwhen: 2026-11-21 19:30 Pacific"), now)).toBeUndefined();
  });

  it("keeps a time written with its zone as that instant, in UTC", () => {
    const now = new Date("2026-11-18T12:00:00Z");
    const z = icsOf(block("event", "title: Call\nwhen: <t:2026-11-21T19:30Z:f>\nend: <t:2026-11-21T20:15Z:t>"), now);
    expect(z).toContain("DTSTART:20261121T193000Z\r\n");
    expect(z).toContain("DTEND:20261121T201500Z\r\n");
    const offset = icsOf(block("event", "title: Call\nwhen: <t:2026-11-21T23:30+05:30:f>"), now);
    expect(offset).toContain("DTSTART:20261121T180000Z\r\n");
    expect(offset).toContain("DTEND:20261121T190000Z\r\n");
    expect(icsOf(block("event", "title: Call\nwhen: 2026-11-21T01:00-0800"), now)).toContain("DTSTART:20261121T090000Z");
    // A floating end for a zoned start is no end: an hour after the start, in UTC too.
    expect(icsOf(block("event", "title: Call\nwhen: 2026-11-21T19:30Z\nend: 2026-11-21 21:00"), now)).toContain("DTEND:20261121T203000Z");
    expect(icsOf(email, now)).toBeUndefined();
  });

  it("folds a long iCalendar line", () => {
    const ics = icsOf(block("event", `title: ${"x".repeat(100)}\nwhen: 2026-11-21`)) ?? "";
    expect(ics.split("\r\n").every((l) => l.length <= 75)).toBe(true);
    expect(ics).toContain("\r\n x");
  });

  it("folds by octets, never inside a character", () => {
    const ics = icsOf(block("event", `title: ${"é".repeat(60)}${"🎉".repeat(20)}\nwhen: 2026-11-21`)) ?? "";
    const utf8 = new TextEncoder();
    for (const l of ics.split("\r\n")) expect(utf8.encode(l).length).toBeLessThanOrEqual(75);
    // Unfolded, it is the title again, every character whole.
    expect(ics.replace(/\r\n /g, "")).toContain(`SUMMARY:${"é".repeat(60)}${"🎉".repeat(20)}`);
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

describe("the Swift table", () => {
  const swift = readFileSync(new URL("../../device-shared/Sources/DeviceCore/KOSBlock.swift", import.meta.url), "utf8");
  /** A kind as KOSBlock.swift writes it, one line each. */
  const line = (k: (typeof BLOCK_KINDS)[number]): string => {
    const fields = k.fields.map((f) => `.init("${f.key}", "${f.label}"${f.list ? ", list: true" : ""})`).join(", ");
    const title = k.title ? `"${k.title}"` : "nil";
    const actions = k.actions.map((a) => `.${a}`).join(", ");
    return `BlockKind(name: "${k.name}", label: "${k.label}", plain: "${k.plain}", fields: [${fields}], title: ${title}, body: .${k.body}, copies: .${k.copies}, actions: [${actions}]),`;
  };

  it("is this table, kind for kind, so KOS for Mac and the phone draw what the dashboard does", () => {
    const written = swift.split("\n").filter((l) => l.trim().startsWith("BlockKind(name:")).map((l) => l.trim());
    expect(written).toEqual(BLOCK_KINDS.map(line));
  });
});
