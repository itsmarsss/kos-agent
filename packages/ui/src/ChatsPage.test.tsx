// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { api, type ChatEvent, type Conversation } from "./api.js";
import { ChatsPage } from "./ChatsPage.js";

/**
 * The chat as a screen reader and a keyboard meet it: a log of who said
 * what, buttons named for the message they act on, a long chat read from
 * its end with the rest a press away, and no key in the box that switches
 * the chat to Auto.
 */

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.scrollTo = vi.fn() as never;
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
});

const chat: Conversation = { id: "c1", userId: "owner", title: "Garden", channel: "dashboard", createdAt: 1, updatedAt: 2, archived: false, brief: null, toolAllow: null, projectSlug: null, kind: "chat" };
const at = (min: number): number => Date.UTC(2026, 10, 22, 18, min);
const you = (text: string, m: number): ChatEvent => ({ kind: "message", role: "you", text, at: at(m) });
const kos = (text: string, m: number): ChatEvent => ({ kind: "message", role: "kos", text, at: at(m) });

let reads: (number | undefined)[];
function serve(pages: (last: number | undefined) => { events: ChatEvent[]; earlier?: number; ownerAbove?: number }): void {
  reads = [];
  vi.spyOn(api, "conversation").mockImplementation(async (_id: string, last?: number) => {
    reads.push(last);
    return { id: "c1", messages: [], pending: [], ...pages(last) };
  });
}

beforeEach(() => {
  // Whatever else the page asks for on its way up answers empty.
  for (const key of ["tools", "chatMode", "channels", "discordInfo", "artifacts", "models"] as const) {
    if (key in api) vi.spyOn(api as never, key as never).mockResolvedValue([] as never);
  }
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function page(): ReturnType<typeof render> {
  return render(
    <ChatsPage
      conversations={[chat]}
      projects={[]}
      activeId="c1"
      pendingApprovals={new Set()}
      approvals={[]}
      deciding={new Set()}
      agents={[]}
      onOpenAgent={() => undefined}
      crons={[]}
      onEditCron={() => undefined}
      onOpen={() => undefined}
      onOpenProject={() => undefined}
      onAside={() => undefined}
      onNotice={() => undefined}
      onChanged={() => undefined}
      onDecide={() => undefined}
    />,
  );
}

describe("the chat, heard", () => {
  it("is a log of turns, each said by who and when, its buttons named for it", async () => {
    serve(() => ({ events: [you("Plan the weekend", 1), kos("Here is a plan.", 2)] }));
    page();
    const log = await screen.findByRole("log", { name: "Messages with Garden" });
    expect(log.getAttribute("aria-live")).toBe("polite");
    await within(log).findByText("Here is a plan.");
    const yours = within(log).getByRole("article", { name: /^You said, / });
    const reply = within(log).getByRole("article", { name: /^KOS said, / });
    expect(within(yours).getByRole("button", { name: /^Edit your message, / })).toBeTruthy();
    expect(within(reply).getByRole("button", { name: /^Copy KOS's reply, / })).toBeTruthy();
    expect(within(reply).queryByRole("button", { name: /^Copy$/ })).toBeNull();
  });

  it("says when a message sent first was answered after the ones above it", async () => {
    serve(() => ({ events: [you("Message 1", 5), kos("Noted.", 6), you("Message 0", 1), kos("Fetched.", 9)] }));
    page();
    expect(await screen.findByText(/before the messages above; answered after them/)).toBeTruthy();
    expect(screen.getAllByText(/answered after them/)).toHaveLength(1);
  });
});

describe("a long chat", () => {
  it("opens on its newest stretch, and Show earlier reads back further", async () => {
    serve((last) => (last && last > 200 ? { events: [you("Message 0", 1), kos("Old.", 2), you("Message 9", 3), kos("New.", 4)] } : { events: [you("Message 9", 3), kos("New.", 4)], earlier: 2, ownerAbove: 1 }));
    page();
    const more = await screen.findByRole("button", { name: "Show earlier messages (2)" });
    expect(reads[0]).toBe(200);
    expect(screen.queryByText("Message 0")).toBeNull();
    await act(async () => void fireEvent.click(more));
    expect(await screen.findByText("Message 0")).toBeTruthy();
    expect(reads.at(-1)).toBe(400);
    expect(screen.queryByRole("button", { name: /Show earlier/ })).toBeNull();
  });

  it("numbers the owner's turns as KOS holds them, past those above the cut", async () => {
    serve(() => ({ events: [you("Message 9", 3), kos("New.", 4)], earlier: 6, ownerAbove: 3 }));
    const rewind = vi.spyOn(api, "rewind").mockResolvedValue({ reply: "", conversationId: "c1" });
    page();
    fireEvent.click(await screen.findByRole("button", { name: /^Retry your message, / }));
    await waitFor(() => expect(rewind).toHaveBeenCalledWith("c1", 3, {}));
  });

  it("offers no change to a message above the line a chat was set aside under", async () => {
    serve(() => ({ events: [you("Old words", 1), kos("Old.", 2), { kind: "divider", at: at(3), text: "Past chat memory: what is above is kept for you, not for KOS" }, you("New words", 4), kos("New.", 5)] }));
    const rewind = vi.spyOn(api, "rewind").mockResolvedValue({ reply: "", conversationId: "c1" });
    page();
    const log = await screen.findByRole("log");
    await within(log).findByText("New words");
    const old = within(log).getAllByRole("article", { name: /^You said/ })[0]!;
    expect(within(old).queryByRole("button", { name: /^Retry/ })).toBeNull();
    fireEvent.click(within(log).getByRole("button", { name: /^Retry your message, / }));
    await waitFor(() => expect(rewind).toHaveBeenCalledWith("c1", 0, {}));
  });
});

describe("the chat's box", () => {
  it("lets Shift+Tab leave it, and no key there changes Ask or Auto", async () => {
    serve(() => ({ events: [] }));
    const setMode = vi.spyOn(api, "setChatMode" as never).mockResolvedValue({} as never);
    page();
    const box = await screen.findByRole("textbox", { name: /Message Garden/ });
    const leaving = fireEvent.keyDown(box, { key: "Tab", shiftKey: true });
    // Not prevented: the browser moves the focus back, as from any box.
    expect(leaving).toBe(true);
    expect(screen.getByRole("button", { name: /^Mode: Ask/ })).toBeTruthy();
    expect(setMode).not.toHaveBeenCalled();
  });
});
