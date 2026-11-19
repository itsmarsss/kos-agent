import { ApplicationCommandOptionType, InteractionContextType } from "discord.js";
import { CHAT_COMMANDS } from "@kos/shared";
import { describe, expect, it } from "vitest";

import { approvalCompletions, commandCard, commandText, completions, jobCompletions, jobNamed, slashCommands, surfaceCommand, surfaceCommands, type SlashContext } from "./commands.js";

function ctxWith(chats: { id: string; title: string; kind: string }[], start?: string): SlashContext {
  return {
    list: () => chats,
    current: () => start,
    home: () => "discord:owner",
    run: async (text) => ({ reply: text }),
    link: (id: string) => `http://host/#/chats/${id}`,
  };
}

const chats = [
  { id: "discord:owner", title: "Discord", kind: "surface" },
  { id: "a", title: "Book CRM", kind: "chat" },
  { id: "b", title: "3js shooter", kind: "chat" },
  { id: "project:garden", title: "Garden", kind: "project" },
];

describe("slash commands", () => {
  it("offers every chat when nothing has been typed", () => {
    expect(completions(ctxWith(chats), "").map((c) => c.value)).toEqual(["discord:owner", "a", "b", "project:garden"]);
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

  it("marks a project's orchestrator so it reads as the project", () => {
    expect(completions(ctxWith(chats), "gard")[0]?.name).toBe("◆ Garden");
  });
});

describe("one registry for every surface", () => {
  it("registers every command a chat surface runs, from the shared list, and none of the dashboard's own", () => {
    const names = (slashCommands("everywhere") as { name: string }[]).map((c) => c.name);
    expect(names).toEqual(CHAT_COMMANDS.filter((c) => c.where !== "dashboard").flatMap((c) => [c.name, ...(c.aliases ?? [])]));
    for (const name of ["mode", "stop", "status", "new", "inbox", "approve", "deny", "compact", "retry", "fork", "rename", "archive", "project", "run", "halt", "resume", "switch", "here"]) expect(names, name).toContain(name);
    expect(names).not.toContain("btw");
    expect(names).not.toContain("export");
  });

  it("keeps within what Discord takes: names, descriptions, options", () => {
    for (const c of slashCommands("everywhere") as { name: string; description: string; options?: { name: string; description: string; type: number }[] }[]) {
      expect(c.name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
      expect(c.description.length).toBeGreaterThan(0);
      expect(c.description.length).toBeLessThanOrEqual(100);
      for (const o of c.options ?? []) {
        expect(o.name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
        expect(o.description.length).toBeLessThanOrEqual(100);
        expect(o.type).toBe(ApplicationCommandOptionType.String);
      }
    }
  });

  it("offers a picker where the registry says what to pick, and fixed choices for /mode", () => {
    const by = new Map((slashCommands("everywhere") as { name: string; options?: { autocomplete?: boolean; choices?: { value: string }[]; required?: boolean }[] }[]).map((c) => [c.name, c.options?.[0]]));
    expect(by.get("switch")).toMatchObject({ autocomplete: true, required: true });
    expect(by.get("approve")).toMatchObject({ autocomplete: true, required: false });
    expect(by.get("run")).toMatchObject({ autocomplete: true });
    expect(by.get("mode")?.choices?.map((c) => c.value)).toEqual(["ask", "auto"]);
    expect(by.get("status")).toBeUndefined();
  });

  it("registers /target as /switch, picker and all, typed as the kernel reads it", () => {
    const by = new Map((slashCommands("everywhere") as { name: string; description: string; options?: unknown[] }[]).map((c) => [c.name, c]));
    expect(by.get("target")?.options).toEqual(by.get("switch")?.options);
    expect(by.get("target")?.description).toBe(by.get("switch")?.description);
    expect(surfaceCommand("target")?.option?.pick).toBe("chat");
    expect(commandText("target", "Garden")).toBe("/target Garden");
  });

  it("shows the server's commands to its administrators alone, and the DM's to the owner", () => {
    const guild = slashCommands("guild") as { defaultMemberPermissions?: bigint }[];
    expect(guild.every((c) => c.defaultMemberPermissions === 0n)).toBe(true);
    expect((slashCommands("dm") as { defaultMemberPermissions?: bigint }[]).every((c) => c.defaultMemberPermissions === undefined)).toBe(true);
  });

  it("registers for the DM alone globally when the server has its own", () => {
    const dm = slashCommands("dm") as { contexts?: number[] }[];
    expect(dm.every((c) => c.contexts?.length === 1 && c.contexts[0] === InteractionContextType.BotDM)).toBe(true);
    expect((slashCommands("guild") as { contexts?: number[] }[]).every((c) => c.contexts === undefined)).toBe(true);
  });

  it("types a command as the kernel reads it", () => {
    expect(commandText("mode", "auto")).toBe("/mode auto");
    expect(commandText("status")).toBe("/status");
    expect(commandText("rename", "  Taxes  ")).toBe("/rename Taxes");
  });

  it("answers with a card, saying when a move made in a room moves the DM", () => {
    expect(commandCard("status", { reply: "Nothing is running." })).toMatchObject({ title: "/status", body: "Nothing is running." });
    expect(commandCard("new", { reply: "Started", switchedTo: "c9" }, { room: true }).footer).toBe("moves your DMs; this channel stays with its own chat");
    expect(commandCard("new", { reply: "Started", switchedTo: "c9" }).footer).toBeUndefined();
    expect(commandCard("tools", { reply: "Opening", opens: "tools" }, { tools: "http://host/#/chats/a" }).body).toContain("[Open the tool scope](http://host/#/chats/a)");
  });

  it("offers waiting asks by what they do, chosen by number", () => {
    const ctx: SlashContext = { ...ctxWith(chats), pending: () => [{ id: "12", text: "x" }, { id: "13", text: "y" }] };
    expect(approvalCompletions(ctx, "", (r) => (r.id === "12" ? "Run rm" : "Post to #general"))).toEqual([
      { name: "#12 Run rm", value: "12" },
      { name: "#13 Post to #general", value: "13" },
    ]);
    expect(approvalCompletions(ctx, "#13", () => "x").map((c) => c.value)).toEqual(["13"]);
  });

  it("is the list surfaceCommands gives every surface but the dashboard", () => {
    expect(surfaceCommands().every((c) => c.where !== "dashboard")).toBe(true);
  });
});

describe("picking a job for /run", () => {
  const jobs = [
    { id: 7, name: "Morning brief", enabled: true },
    { id: 9, name: "School Evening Nudge", enabled: false },
    { id: 12, name: "School Morning Digest", enabled: true },
  ];
  const withJobs = (): SlashContext => ({ ...ctxWith(chats), jobs: () => jobs });

  it("offers the jobs themselves by id, never run ones included, paused ones marked", () => {
    const all = jobCompletions(withJobs(), "");
    expect(all.map((c) => c.value)).toEqual(["7", "9", "12"]);
    expect(all[1]?.name).toBe("\u23f1 School Evening Nudge (paused)");
    expect(jobCompletions(withJobs(), "digest").map((c) => c.value)).toEqual(["12"]);
    // The chat list leaves schedules out; the job list is its own.
    expect(completions(withJobs(), "").map((c) => c.value)).not.toContain("7");
    expect(jobCompletions(ctxWith(chats), "")).toEqual([]);
  });

  it("resolves what /run was given to an id, and a typed name to its id at once", () => {
    const ctx = withJobs();
    expect(jobNamed(ctx, "7")).toBe(7);
    expect(jobNamed(ctx, "cron:12")).toBe(12);
    expect(jobNamed(ctx, "morning brief")).toBe(7);
    expect(jobNamed(ctx, "evening")).toBe(9);
    // Two jobs match "school": not a guess, nothing.
    expect(jobNamed(ctx, "school")).toBeUndefined();
    expect(jobNamed(ctx, "nothing like it")).toBeUndefined();
    expect(jobNamed(ctx, "")).toBeUndefined();
    expect(jobNamed(ctx, undefined)).toBeUndefined();
  });
});
