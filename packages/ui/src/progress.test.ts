// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { browsingNow, clearProgress, onRenamed, onTurnEnd, seedProgress, settleProgress, useProgress, type Live } from "./progress.js";

/**
 * The store is a module singleton watching the dashboard's one socket, so
 * these drive it through the exported handles and read it through the hook,
 * which is how the app sees it.
 */
class FakeSocket {
  static OPEN = 1;
  readyState = 1;
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  send(): void {}
  close(): void {}
}

let source: FakeSocket;

function deliver(event: Record<string, unknown>): void {
  act(() => {
    source.onmessage?.({ data: JSON.stringify({ channel: "events", event }) });
  });
}

describe("progress handover", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "WebSocket",
      Object.assign(
        function WebSocketStub() {
          source = new FakeSocket();
          return source;
        },
        { OPEN: 1 },
      ),
    );
  });

  afterEach(() => {
    cleanup();
    clearProgress("c1");
    vi.unstubAllGlobals();
  });

  it("keeps what the owner said elsewhere, so the page can show it at once", () => {
    const { result } = renderHook(() => useProgress());
    deliver({ kind: "turn-start", conversationId: "c1", said: "what time is it", from: "discord", origin: { via: "discord", room: { kind: "channel", name: "verity" } }, files: [{ name: "a.pdf", path: "uploads/a.pdf" }] });
    expect(result.current["c1"]).toMatchObject({ said: "what time is it", from: "discord", origin: { via: "discord", room: { kind: "channel", name: "verity" } }, files: [{ name: "a.pdf", path: "uploads/a.pdf" }], steps: [] });
    deliver({ kind: "turn-start", conversationId: "c1" });
    expect(result.current["c1"]?.said).toBeUndefined();
    // The row a turn runs, when its words waited, so the page lets that row go.
    deliver({ kind: "turn-start", conversationId: "c1", said: "and the red one", pendingId: 9 });
    expect(result.current["c1"]).toMatchObject({ said: "and the red one", pendingId: 9 });
  });

  it("counts a turn from when the host says it began, so a replay after a reconnect keeps its clock", () => {
    const { result } = renderHook(() => useProgress());
    const began = Date.now() - 90_000;
    deliver({ kind: "turn-start", conversationId: "c1", at: began });
    expect(result.current["c1"]?.since).toBe(began);
    // A clock ahead of this page's never starts the turn in the future.
    deliver({ kind: "turn-start", conversationId: "c1", at: Date.now() + 60_000 });
    expect(result.current["c1"]!.since).toBeLessThanOrEqual(Date.now());
  });

  it("puts a step's picture on the latest step of its tool, as the transcript will", () => {
    const { result } = renderHook(() => useProgress());
    deliver({ kind: "turn-start", conversationId: "c1" });
    deliver({ kind: "tool-start", conversationId: "c1", tool: "browser.act", summary: "Open the form" });
    deliver({ kind: "tool-end", conversationId: "c1", tool: "browser.act", isError: false });
    deliver({ kind: "tool-start", conversationId: "c1", tool: "browser.act", summary: "Fill it in" });
    deliver({ kind: "tool-start", conversationId: "c1", tool: "files.ls", summary: "List ." });
    deliver({ kind: "frame", conversationId: "c1", tool: "browser.act", frameId: 7 });
    const steps = result.current.c1?.steps ?? [];
    expect(steps.map((s) => (s.kind === "tool" ? s.frameId : null))).toEqual([undefined, 7, undefined]);
  });

  it("puts words said mid-turn after the step that took them in, as the transcript keeps them", () => {
    const { result } = renderHook(() => useProgress());
    deliver({ kind: "turn-start", conversationId: "c1", said: "build a cart" });
    deliver({ kind: "tool-start", conversationId: "c1", tool: "chrome.start", summary: "Start in Chrome" });
    deliver({ kind: "tool-end", conversationId: "c1", tool: "chrome.start", isError: false });
    deliver({ kind: "heard", conversationId: "c1", said: "skip the ebooks", from: "dashboard" });
    deliver({ kind: "tool-start", conversationId: "c1", tool: "browser.visit", summary: "Search", yours: true });
    const steps = result.current.c1?.steps ?? [];
    expect(steps.map((s) => (s.kind === "said" ? `you: ${s.text}` : s.kind === "tool" ? s.tool : s.kind))).toEqual(["chrome.start", "you: skip the ebooks", "browser.visit"]);
    // Where the step works rides with it, so KOS's browser window stays shut for one in the owner's Chrome.
    expect(steps[2]).toMatchObject({ kind: "tool", yours: true });
    expect(steps[1]).toEqual({ kind: "said", text: "skip the ebooks", from: "dashboard" });
  });

  it("keeps a finished turn's steps until the transcript takes over", () => {
    const { result } = renderHook(() => useProgress());
    deliver({ kind: "turn-start", conversationId: "c1" });
    deliver({
      kind: "tool-start",
      conversationId: "c1",
      tool: "files.ls",
      summary: "List .",
    });
    deliver({ kind: "turn-end", conversationId: "c1" });

    // The turn is over, but dropping it here is what left the screen with
    // neither the steps nor the transcript for the length of a fetch.
    expect(result.current.c1?.ended).toBe(true);
    expect(result.current.c1?.steps).toHaveLength(1);

    act(() => settleProgress("c1"));
    expect(result.current.c1).toBeUndefined();
  });

  it("will not hand over a turn that has started again", () => {
    const { result } = renderHook(() => useProgress());
    deliver({ kind: "turn-start", conversationId: "c1" });
    deliver({ kind: "turn-end", conversationId: "c1" });
    // A fetch that began before this turn started must not throw its steps
    // away when it lands.
    deliver({ kind: "turn-start", conversationId: "c1" });

    act(() => settleProgress("c1"));
    expect(result.current.c1).toBeDefined();
    expect(result.current.c1?.ended).toBeUndefined();
  });

  it("keeps a congregation's roster on the turn, replaced whole as it moves", () => {
    const { result } = renderHook(() => useProgress());
    deliver({ kind: "turn-start", conversationId: "c1" });
    deliver({
      kind: "congregation",
      conversationId: "c1",
      members: [{ id: "a", title: "A", status: "working" }],
    });
    expect(result.current.c1?.congregation?.members[0]?.status).toBe("working");

    deliver({
      kind: "congregation",
      conversationId: "c1",
      members: [{ id: "a", title: "A", status: "done" }],
    });
    expect(result.current.c1?.congregation?.members[0]?.status).toBe("done");

    // The roster stays up while the combined reply streams in under it.
    deliver({ kind: "delta", conversationId: "c1", of: "text", text: "Combined" });
    expect(result.current.c1?.congregation?.members).toHaveLength(1);
    expect(result.current.c1?.text).toBe("Combined");

    // And a fresh turn starts without it.
    deliver({ kind: "turn-start", conversationId: "c1" });
    expect(result.current.c1?.congregation).toBeUndefined();
  });

  it("seeds a turn that started before the page was open", () => {
    const { result } = renderHook(() => useProgress());
    act(() => seedProgress(["c1"]));
    expect(result.current.c1?.resumed).toBe(true);
  });
});

describe("hearing a turn end", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "WebSocket",
      Object.assign(
        function WebSocketStub() {
          source = new FakeSocket();
          return source;
        },
        { OPEN: 1 },
      ),
    );
  });

  afterEach(() => {
    cleanup();
    clearProgress("c1");
    vi.unstubAllGlobals();
  });

  it("tells a listener which conversation's turn ended, until it stops listening", () => {
    // The chat list refreshes on this, so a reply landing in another thread
    // turns its dot green at once rather than on the next poll.
    renderHook(() => useProgress());
    const ended: string[] = [];
    const stop = onTurnEnd((id) => ended.push(id));
    deliver({ kind: "turn-start", conversationId: "c1" });
    deliver({ kind: "turn-end", conversationId: "c1" });
    expect(ended).toEqual(["c1"]);
    stop();
    deliver({ kind: "turn-end", conversationId: "c1" });
    expect(ended).toEqual(["c1"]);
  });

  it("tells a listener a chat's new name, and leaves the running turn as it was", () => {
    // The list and the header fetch again on this, so a name KOS gives lands within a second of the turn starting.
    const { result } = renderHook(() => useProgress());
    const named: [string, string][] = [];
    const stop = onRenamed((id, title) => named.push([id, title]));
    deliver({ kind: "turn-start", conversationId: "c1", said: "draft me a message" });
    deliver({ kind: "renamed", conversationId: "c1", title: "Devpost support refund" });
    expect(named).toEqual([["c1", "Devpost support refund"]]);
    expect(result.current["c1"]?.steps).toEqual([]);
    stop();
  });
});

describe("who is browsing in KOS's own browser", () => {
  const turn = (steps: Live["steps"]): Live => ({ steps, text: "", since: 0 });
  const step = (tool: string, done: boolean, yours?: true) => ({ kind: "tool" as const, tool, summary: tool, done, isError: false, ...(yours ? { yours } : {}) });

  it("names a turn whose latest browser step ran in KOS's browser", () => {
    expect(browsingNow({ c1: turn([step("browser.visit", false)]) })).toEqual({ id: "c1", doing: "browser.visit" });
  });

  it("leaves out a turn working in the owner's Chrome, even after earlier steps in KOS's", () => {
    expect(browsingNow({ c1: turn([step("chrome.start", true), step("browser.visit", false, true)]) })).toBeNull();
    expect(browsingNow({ c1: turn([step("browser.visit", true), step("chrome.start", true), step("browser.act", true, true)]) })).toBeNull();
    expect(browsingNow({ c1: turn([step("browser.act", true, true)]), c2: turn([step("browser.look", true)]) })).toEqual({ id: "c2" });
  });
});
