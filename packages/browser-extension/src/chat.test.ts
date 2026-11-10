import { describe, expect, it } from "vitest";

import { asked, EMPTY, givenBack, isCommand, sent, shown, statused } from "./chat.js";

/** KOS's acknowledgement of words, as the host sends it: a chat not yet made is null, and a command says it is one. */
const taken = (said: string, conversation: string | null): Record<string, unknown> => ({ chat: conversation, conversation, held: false, said, taken: true, ...(isCommand(said) ? { command: true } : {}) });

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

  it("sends words that start with a slash but name no command as a message", () => {
    const said = "/etc/hosts is broken";
    let c = sent({ ...EMPTY, conversation: "c1" }, said);
    expect(c).toMatchObject({ sending: [said], working: true });
    c = statused(c, { chat: "c1", conversation: "c1", held: false, said, taken: true });
    expect(c.sending).toEqual([said]);
    c = statused(c, { chat: "c1", conversation: "c1", held: false, said, story: "› Read the file" });
    expect(c.stories).toEqual([{ after: 1, said, text: "› Read the file" }]);
  });

  it("gives words that name no command back to the box when KOS never takes them", () => {
    const c = givenBack(sent({ ...EMPTY, conversation: "c1" }, "/etc/hosts is broken"));
    expect(c).toMatchObject({ sending: [], working: false, unsent: "/etc/hosts is broken" });
  });

  it("knows a command by its name", () => {
    expect(["/new", "  /switch 2", "/Stop"].every(isCommand)).toBe(true);
    expect(["/etc/hosts is broken", "/", "new"].some(isCommand)).toBe(false);
  });

  it("lets a command KOS knows by another name go", () => {
    const c = statused(sent({ ...EMPTY, conversation: "c1" }, "/cancel"), { chat: "c1", conversation: "c1", held: false, said: "/cancel", taken: true, command: true });
    expect(c.sending).toEqual([]);
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

  it("starts afresh when the first chat is made from none", () => {
    let c = shown(EMPTY, { conversation: null, title: "Chrome", messages: [], notice: { text: "Nothing is running." }, pictures: { "7": "QUJD" } });
    c = statused(sent(c, "/new"), taken("/new", null));
    c = shown(c, { conversation: "c1", title: "New conversation", messages: [], notice: { text: "Started 'New conversation'" } });
    expect(c).toMatchObject({ conversation: "c1", working: false, sending: [] });
    // What was said while no chat was shown is not this chat's.
    expect(c.extras.map((x) => x.text)).toEqual(["Started 'New conversation'"]);
    expect([...c.pictures.keys()]).toEqual([]);
  });

  it("keeps an ask made while no chat was shown once its chat is", () => {
    let c = asked(EMPTY, { chat: "c1", approval: { id: "a1", tool: "browser.act" } });
    c = shown(c, { conversation: "c1", title: "Chat", messages: [you("Buy it")], notice: { text: "Waiting on you", waiting: true } });
    expect(c.asks.map((a) => a.id)).toEqual(["a1"]);
  });

  it("drops another chat's ask when a chat is shown afresh", () => {
    let c = asked({ ...EMPTY, conversation: "c1" }, { chat: "c1", approval: { id: "a1", tool: "browser.act" } });
    c = shown(c, { conversation: "c2", title: "Other", messages: [] });
    expect(c.asks).toEqual([]);
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
