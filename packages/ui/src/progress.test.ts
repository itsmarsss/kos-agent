// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearProgress, seedProgress, settleProgress, useProgress } from "./progress.js";

/**
 * The store is a module singleton behind one EventSource, so these drive it
 * through the exported handles and read it through the hook, which is how the
 * app sees it.
 */
class FakeSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close(): void {}
}

let source: FakeSource;

function deliver(event: Record<string, unknown>): void {
  act(() => {
    source.onmessage?.({ data: JSON.stringify(event) });
  });
}

describe("progress handover", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("EventSource", function EventSourceStub(this: FakeSource) {
      source = new FakeSource();
      return source;
    });
  });

  afterEach(() => {
    cleanup();
    clearProgress("c1");
    vi.unstubAllGlobals();
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

  it("seeds a turn that started before the page was open", () => {
    const { result } = renderHook(() => useProgress());
    act(() => seedProgress(["c1"]));
    expect(result.current.c1?.resumed).toBe(true);
  });
});
