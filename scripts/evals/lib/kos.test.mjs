import { describe, expect, it } from "vitest";

import { Kos } from "./kos.mjs";

/** A Kos over a chat whose listing and replies the test sets, with no host behind it. */
function over(chat) {
  const kos = new Kos({ url: "http://127.0.0.1:0" }, () => undefined);
  kos.conversations = async () => [chat];
  kos.replies = async () => chat.replies;
  return kos;
}

describe("the eval run's wait on a decided chat", () => {
  it("counts a resume too quick to be seen working once a reply lands", async () => {
    const chat = { id: "c1", activity: "idle", updatedAt: 100, replies: ["Waiting on you"] };
    const kos = over(chat);
    await kos.decided("c1");
    expect(await kos.resumed([chat])).toBe(false);
    chat.replies = [...chat.replies, "Done."];
    expect(await kos.resumed([chat])).toBe(true);
  });

  it("counts a resume once the chat changed after the decision", async () => {
    const chat = { id: "c1", activity: "idle", updatedAt: 100, replies: [] };
    const kos = over(chat);
    await kos.decided("c1");
    chat.updatedAt = 200;
    expect(await kos.resumed([chat])).toBe(true);
  });

  it("waits while the resumed turn works", async () => {
    const chat = { id: "c1", activity: "idle", updatedAt: 100, replies: [] };
    const kos = over(chat);
    await kos.decided("c1");
    chat.activity = "working";
    chat.updatedAt = 200;
    expect(await kos.resumed([chat])).toBe(false);
    chat.activity = "idle";
    expect(await kos.resumed([chat])).toBe(true);
  });
});
