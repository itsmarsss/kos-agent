import { describe, expect, it } from "vitest";

import { linkMentions, mentionRoute } from "./mentions.js";

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
      "[Email Amy Reminder](https://kos.example/#/schedule) ran",
    );
  });

  it("routes each kind where its chip goes", () => {
    expect(mentionRoute("file", "notes/a b.md")).toBe("#/files/notes%2Fa%20b.md");
    expect(mentionRoute("project", "garden")).toBe("#/project/garden");
    expect(mentionRoute("chat", "c9:owner")).toBe("#/chats/c9%3Aowner");
    expect(mentionRoute("agent", "3")).toBe("#/agents/3");
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

  it("drops a trailing slash on the base and keeps other text as it was", () => {
    expect(linkMentions("@project:garden", "http://localhost:4317/")).toBe("[garden](http://localhost:4317/#/project/garden)");
    expect(linkMentions("nothing here", base)).toBe("nothing here");
  });
});
