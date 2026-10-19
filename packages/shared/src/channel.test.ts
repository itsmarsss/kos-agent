import { describe, expect, it } from "vitest";

import { channelNamesIn } from "./channel.js";

describe("a channel named in words", () => {
  it("reads #name at a word's start, once each, in order", () => {
    expect(channelNamesIn("post in #leetcode, then #general and #LeetCode again")).toEqual(["leetcode", "general"]);
  });

  it("leaves what only looks like one", () => {
    // Inside a word, a mention Discord already made, an anchor in a URL, an entity.
    expect(channelNamesIn("C#, <#123>, https://x.test/#/chats, &#39; and # alone")).toEqual([]);
  });

  it("takes an issue number or a colour as a name, since a channel may be called that; whoever renders checks", () => {
    expect(channelNamesIn("fix #3 and #3b82f6")).toEqual(["3", "3b82f6"]);
  });
});
