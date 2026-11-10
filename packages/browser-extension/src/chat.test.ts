import { describe, expect, it } from "vitest";

import { EMPTY, shown, statused, type Chat } from "./chat.js";

/** The panel as send() leaves it: words on their way, or a command, which waits only for its answer. */
function sent(c: Chat, text: string): Chat {
  return { ...c, sending: text.startsWith("/") ? c.sending : [...c.sending, text], working: true };
}

/** KOS's acknowledgement of words, as the host sends it: a chat not yet made is null. */
const taken = (said: string, conversation: string | null): Record<string, unknown> => ({ chat: conversation, conversation, held: false, said, taken: true });

const kos = (text: string) => ({ role: "kos" as const, text });
const you = (text: string) => ({ role: "you" as const, text });

describe("the side panel's chat", () => {
  it("starts a chat from none with /new, then is ready for the next words", () => {
    let c = sent(EMPTY, "/new");
    c = statused(c, taken("/new", null));
    expect(c.sending).toEqual([]);
    expect(c.taken).toBeUndefined();
    c = shown(c, { conversation: "c1", title: "New conversation", messages: [], notice: { text: "Started 'New conversation'" } });
    expect(c).toMatchObject({ conversation: "c1", working: false, sending: [] });
    c = statused(sent(c, "Find the cheapest one"), taken("Find the cheapest one", "c1"));
    expect(c).toMatchObject({ working: true, sending: ["Find the cheapest one"], taken: { said: "Find the cheapest one" } });
  });

  it("never waits on a command's own words in a chat it is already in", () => {
    for (const command of ["/stop", "/clear", "/new", "/switch 2"]) {
      const c = statused(sent({ ...EMPTY, conversation: "c1" }, command), taken(command, "c1"));
      expect(c.sending).toEqual([]);
    }
  });

  it("lets /stop go when no chat is made yet", () => {
    let c = statused(sent(EMPTY, "/stop"), taken("/stop", null));
    c = shown(c, { conversation: null, title: "Chrome", messages: [], notice: { text: "Nothing is running." } });
    expect(c).toMatchObject({ conversation: null, working: false, sending: [] });
  });

  it("lets /clear go once the chat is shown cleared", () => {
    let c = statused(sent({ ...EMPTY, conversation: "c1", lines: [you("hi"), kos("hello")] }, "/clear"), taken("/clear", "c1"));
    c = shown(c, { conversation: "c1", title: "Chat", messages: [], notice: { text: "Cleared." } });
    expect(c).toMatchObject({ working: false, sending: [] });
  });

  it("lets /switch go from no chat to one, and shows that one afresh", () => {
    let c = statused(sent({ ...EMPTY, extras: [{ after: 0, text: "Nothing is running." }] }, "/switch 2"), taken("/switch 2", null));
    c = shown(c, { conversation: "c2", title: "Shopping", messages: [you("Which is cheaper?"), kos("The second.")], notice: { text: "Switched to 'Shopping'" } });
    expect(c).toMatchObject({ conversation: "c2", working: false, sending: [] });
    expect(c.extras.map((x) => x.text)).toEqual(["Switched to 'Shopping'"]);
  });

  it("starts afresh when the first chat is made from none, leaving nothing on its way", () => {
    const c = shown({ ...EMPTY, sending: ["/new"], working: true }, { conversation: "c1", title: "New conversation", messages: [], notice: { text: "Started 'New conversation'" } });
    expect(c).toMatchObject({ conversation: "c1", working: false, sending: [] });
  });

  it("keeps words on their way when the same chat is shown before it has them", () => {
    const c = shown(sent({ ...EMPTY, conversation: "c1", lines: [you("a"), kos("b")] }, "next"), { conversation: "c1", title: "Chat", messages: [you("a"), kos("b")] });
    expect(c).toMatchObject({ sending: ["next"], working: true });
  });

  it("shows words said elsewhere as on their way, and works on them", () => {
    const c = statused({ ...EMPTY, conversation: "c1" }, taken("From the dashboard", "c1"));
    expect(c).toMatchObject({ sending: ["From the dashboard"], working: true });
  });

  it("leaves the chat alone for a status about another one", () => {
    const c = { ...EMPTY, conversation: "c1" };
    expect(statused(c, { chat: "c9", conversation: "c9", said: "x", story: "› Click" })).toBe(c);
  });

  it("ends the turn when its story closes", () => {
    let c = statused(sent({ ...EMPTY, conversation: "c1" }, "go"), taken("go", "c1"));
    c = statused(c, { chat: "c1", conversation: "c1", said: "go", story: "› Open the page" });
    expect(c.working).toBe(true);
    c = shown(c, { conversation: "c1", title: "Chat", messages: [you("go"), kos("Done.")] });
    expect(c).toMatchObject({ working: false, sending: [], stories: [] });
  });
});
