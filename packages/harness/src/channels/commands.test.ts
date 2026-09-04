import { describe, expect, it } from "vitest";

import { COMMANDS, completions, runCommand, type SlashContext } from "./commands.js";

function ctxWith(
  chats: { id: string; title: string; kind: string }[],
  start?: string,
): SlashContext & { pointed: string | undefined; stopped: string[] } {
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

  it("points the surface at what was picked", () => {
    const ctx = ctxWith(chats);
    expect(runCommand(ctx, "target", "a")).toBe("Sending to Book CRM.");
    expect(ctx.pointed).toBe("a");
  });

  it("says so when the picker was ignored and text typed instead", () => {
    const ctx = ctxWith(chats);
    expect(runCommand(ctx, "target", "Book CRM")).toContain("No chat called");
    expect(ctx.pointed).toBeUndefined();
  });

  it("goes back to the surface's own thread", () => {
    const ctx = ctxWith(chats, "a");
    runCommand(ctx, "here");
    expect(ctx.pointed).toBe("discord:owner");
  });

  it("marks where messages are going in the list", () => {
    const listed = runCommand(ctxWith(chats, "a"), "chats");
    expect(listed).toContain("→ Book CRM");
    expect(listed).toContain("  # Discord");
  });

  it("stops the chat it is pointed at, and says when there was nothing to stop", () => {
    const ctx = ctxWith(chats, "a");
    expect(runCommand(ctx, "stop")).toBe("Asked it to stop.");
    expect(ctx.stopped).toEqual(["a"]);
    expect(runCommand(ctxWith(chats, "quiet"), "stop")).toContain("Nothing is running");
  });

  it("starts a chat and points at it in one go", () => {
    const ctx = ctxWith(chats);
    expect(runCommand(ctx, "new", "Taxes")).toContain("Started Taxes");
    expect(ctx.pointed).toBe("new-0");
  });

  it("asks for the missing word rather than guessing", () => {
    expect(runCommand(ctxWith(chats), "new", "  ")).toContain("what the chat is for");
    expect(runCommand(ctxWith(chats), "target")).toContain("which chat");
  });

  it("declares every command it answers, and answers every one declared", () => {
    // A command Discord offers and the daemon does not know is a dead entry
    // in the owner's picker.
    for (const spec of COMMANDS) {
      expect(runCommand(ctxWith(chats), spec.name, "a")).not.toContain(
        "No such command",
      );
    }
    expect(runCommand(ctxWith(chats), "nonsense")).toContain("No such command");
  });
});
