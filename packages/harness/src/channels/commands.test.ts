import { describe, expect, it } from "vitest";

import { COMMANDS, completions, runCommand, type SlashContext } from "./commands.js";

function ctxWith(
  chats: { id: string; title: string; kind: string }[],
  start?: string,
): SlashContext & { pointed: string | undefined; stopped: string[] } {
  const link = (id: string): string => `http://host/#/chats/${id}`;
  let pointed = start;
  const stopped: string[] = [];
  const made: { id: string; title: string; kind: string }[] = [];
  return {
    get pointed() {
      return pointed;
    },
    stopped,
    list: () => [...chats, ...made],
    current: () => pointed,
    target: (id) => {
      pointed = id;
    },
    home: () => "discord:owner",
    stop: (id) => {
      stopped.push(id);
      return id !== "quiet";
    },
    create: (title) => {
      const one = { id: `new-${made.length}`, title, kind: "chat" };
      made.push(one);
      return one;
    },
    link,
  };
}

const chats = [
  { id: "discord:owner", title: "Discord", kind: "surface" },
  { id: "a", title: "Book CRM", kind: "chat" },
  { id: "b", title: "3js shooter", kind: "chat" },
];

describe("slash commands", () => {
  it("offers every chat when nothing has been typed", () => {
    expect(completions(ctxWith(chats), "").map((c) => c.value)).toEqual([
      "discord:owner",
      "a",
      "b",
    ]);
  });

  it("narrows as you type, on the title rather than the id", () => {
    const got = completions(ctxWith(chats), "book");
    expect(got.map((c) => c.value)).toEqual(["a"]);
    expect(got[0]?.name).toBe("Book CRM");
  });

  it("marks a surface stream so it is not mistaken for a chat", () => {
    expect(completions(ctxWith(chats), "disc")[0]?.name).toBe("# Discord");
  });

  it("shortens a title Discord would refuse to show", () => {
    // A title here is the owner's first message, so most are longer than the
    // hundred characters a choice may be.
    const long = [{ id: "x", title: "y".repeat(300), kind: "chat" }];
    const name = completions(ctxWith(long), "")[0]!.name;
    expect(name.length).toBeLessThanOrEqual(90);
    expect(name.endsWith("…")).toBe(true);
  });

  it("makes a named chat something the owner can open", () => {
    // A chat named in an answer is usually one they want to look at, and a
    // name they cannot open is a name they have to go and find.
    const said = runCommand(ctxWith(chats), "target", "a");
    expect(said.card?.body).toContain("[Book CRM](http://host/#/chats/a)");
  });

  it("does not let a title break the link it is inside", () => {
    // Brackets in a title would close the link early and leave the rest of
    // it as loose text.
    const odd = [{ id: "x", title: "notes [draft] (old)", kind: "chat" }];
    const said = runCommand(ctxWith(odd), "target", "x");
    expect(said.card?.body).toBe("**[notes draft old](http://host/#/chats/x)**");
  });

  it("points the surface at what was picked, and names it as a heading", () => {
    /*
     * A title here is the owner's first message, so a sentence containing
     * one has eaten its own subject: "Sending to what capabilities does
     * notify have (fork)." Given a heading it reads as a name again.
     */
    const ctx = ctxWith(chats);
    const said = runCommand(ctx, "target", "a");
    expect(said.card?.title).toBe("Now sending to");
    expect(said.card?.body).toContain("Book CRM");
    expect(ctx.pointed).toBe("a");
  });

  it("says so when the picker was ignored and text typed instead", () => {
    const ctx = ctxWith(chats);
    expect(runCommand(ctx, "target", "Book CRM").card?.title).toBe("No such chat");
    expect(ctx.pointed).toBeUndefined();
  });

  it("goes back to the surface's own thread", () => {
    const ctx = ctxWith(chats, "a");
    runCommand(ctx, "here");
    expect(ctx.pointed).toBe("discord:owner");
  });

  it("lists the chats and marks where you are", () => {
    /*
     * The surface's own stream is not listed: /here is how you get back to
     * it, and a picker whose first entry is where you already were is a line
     * spent saying nothing.
     */
    const card = runCommand(ctxWith(chats, "a"), "chats").card!;
    const listed = card.fields![0]!;
    /*
     * One fenced block, not a pill each: boxes of fifteen different widths
     * are a ragged edge rather than a list.
     */
    expect(listed.value.startsWith("```")).toBe(true);
    expect(listed.value.endsWith("```")).toBe(true);
    expect(listed.value).toContain("→ Book CRM");
    expect(listed.value).toContain("  3js shooter");
    expect(listed.value).not.toContain("Discord");
  });

  it("lists a screenful, and says how many there are in all", () => {
    // Fifteen short names read fine; it was long ones set as prose that did
    // not. The picker still searches the rest.
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: `c${i}`,
      title: `chat ${i}`,
      kind: "chat",
    }));
    const card = runCommand(ctxWith(many), "chats").card!;
    // Two of the lines are the fence itself.
    expect(card.fields![0]!.value.split("\n")).toHaveLength(17);
    expect(card.footer).toContain("30 in all");
  });

  it("keeps a long list inside what a field will hold", () => {
    // A title here is a whole message, so a dozen of them overrun the
    // thousand characters a field may be, and Discord refuses the message
    // rather than trimming it.
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: `c${i}`,
      title: `${"a very long conversation title ".repeat(3)}${i}`,
      kind: "chat",
    }));
    const card = runCommand(ctxWith(many), "chats").card!;
    for (const field of card.fields ?? []) {
      expect(field.value.length).toBeLessThanOrEqual(1000);
    }
    expect(card.footer).toContain("in all");
  });

  it("stops the chat it is pointed at, and says when there was nothing to stop", () => {
    const ctx = ctxWith(chats, "a");
    expect(runCommand(ctx, "stop").card?.title).toBe("Asked it to stop");
    expect(ctx.stopped).toEqual(["a"]);
    expect(runCommand(ctxWith(chats, "quiet"), "stop").card?.title).toBe(
      "Nothing to stop",
    );
  });

  it("starts a chat and points at it in one go", () => {
    const ctx = ctxWith(chats);
    expect(runCommand(ctx, "new", "Taxes").card?.body).toContain("Taxes");
    expect(ctx.pointed).toBe("new-0");
  });

  it("asks for the missing word rather than guessing", () => {
    expect(runCommand(ctxWith(chats), "new", "  ").card?.title).toContain(
      "what it is for",
    );
    // Nothing picked is a question, not a mistake: it shows the list.
    expect(runCommand(ctxWith(chats), "target").card?.title).toBe(
      "Where you can send",
    );
  });

  it("declares every command it answers, and answers every one declared", () => {
    // A command Discord offers and the daemon does not know is a dead entry
    // in the owner's picker.
    for (const spec of COMMANDS) {
      const said = runCommand(ctxWith(chats), spec.name, "a");
      expect(said.card?.title, spec.name).not.toBe("No such command");
      // Every one answers with a card, so they read as one set of commands
      // rather than as unrelated features.
      expect(Boolean(said.card), spec.name).toBe(true);
    }
    expect(runCommand(ctxWith(chats), "nonsense").card?.title).toBe(
      "No such command",
    );
  });
});
