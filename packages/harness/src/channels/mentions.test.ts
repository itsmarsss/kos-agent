import { describe, expect, it } from "vitest";

import { linkMentions, linkPaths, mentionRoute, plainMentions } from "./mentions.js";

/**
 * On Discord a reference token is a typo unless it becomes a link. The
 * link goes where the dashboard's chip would.
 */
describe("linking references for Discord", () => {
  const base = "https://kos.example";

  it("turns plain and bracketed tokens into links to the dashboard", () => {
    expect(linkMentions("see @page:book_crm_home today", base)).toBe(
      "see [book_crm_home](https://kos.example/#/page/book_crm_home) today",
    );
    expect(linkMentions("@schedule:[Email Amy Reminder] ran", base)).toBe(
      "[Email Amy Reminder](https://kos.example/#/schedule/Email%20Amy%20Reminder) ran",
    );
  });

  it("routes each kind where its chip goes", () => {
    expect(mentionRoute("file", "notes/a b.md")).toBe("#/files/notes%2Fa%20b.md");
    expect(mentionRoute("project", "garden")).toBe("#/project/garden");
    expect(mentionRoute("chat", "c9:owner")).toBe("#/chats/c9%3Aowner");
    expect(mentionRoute("agent", "research")).toBe("#/blobs/research");
    expect(mentionRoute("build", "3")).toBe("#/builds/3");
    expect(mentionRoute("site", "garden/home")).toBe("#/files/projects%2Fgarden%2Fsites%2Fhome");
    expect(mentionRoute("unknown", "x")).toBe("#/projects");
  });

  it("leaves a token inside code alone", () => {
    const text = "type `@page:home` or\n```\n@file:x.md\n```\nthen @page:home";
    expect(linkMentions(text, base)).toBe(
      "type `@page:home` or\n```\n@file:x.md\n```\nthen [home](https://kos.example/#/page/home)",
    );
  });

  it("tidies the token to its name when there is nowhere to link", () => {
    expect(linkMentions("open @page:home")).toBe("open **home**");
  });

  it("tidies the token to its bare name where nothing renders, leaving code alone", () => {
    expect(plainMentions("Recap for @project:garden and @schedule:[Email Amy]")).toBe("Recap for garden and Email Amy");
    expect(plainMentions("see `@page:home`")).toBe("see `@page:home`");
  });

  it("drops a trailing slash on the base and keeps other text as it was", () => {
    expect(linkMentions("@project:garden", "http://localhost:4317/")).toBe("[garden](http://localhost:4317/#/project/garden)");
    expect(linkMentions("nothing here", base)).toBe("nothing here");
  });
});

describe("an id with colons", () => {
  it("is one reference, not a chip and a tail", () => {
    const base = "https://kos.example";
    expect(linkMentions("by @schedule:blob:briefing at 07:30", base)).toBe("by [blob:briefing](https://kos.example/#/schedule/blob%3Abriefing) at 07:30");
    expect(linkMentions("in @chat:cmv1:owner.", base)).toBe("in [cmv1:owner](https://kos.example/#/chats/cmv1%3Aowner).");
    expect(plainMentions("by @schedule:blob:briefing at")).toBe("by blob:briefing at");
  });
});

describe("linkPaths", () => {
  it("links a workspace path a step names to the file on the dashboard, and nothing that is not one", () => {
    const base = "https://kos.example";
    expect(linkPaths("Read blobs/verity/blob.md.", base)).toBe("Read [blobs/verity/blob.md](<https://kos.example/#/files/blobs%2Fverity%2Fblob.md>).");
    expect(linkPaths("List projects/garden", base)).toBe("List [projects/garden](<https://kos.example/#/files/projects%2Fgarden>)");
    // Not a workspace path: a zone, an absolute path, code, or a reference already linked.
    expect(linkPaths("timezone=America/Toronto (in /w/projects/x)", base)).toBe("timezone=America/Toronto (in /w/projects/x)");
    expect(linkPaths("Run `cat projects/x/a.md`", base)).toBe("Run `cat projects/x/a.md`");
    expect(linkPaths("see @file:projects/x/a.md", base)).toBe("see @file:projects/x/a.md");
    expect(linkPaths(linkMentions("see @file:projects/x/a.md", base), base)).toBe(linkMentions("see @file:projects/x/a.md", base));
    // Nowhere to link to: the words as they were.
    expect(linkPaths("Read blobs/verity/blob.md")).toBe("Read blobs/verity/blob.md");
  });
});
