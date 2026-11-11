// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { api } from "./api.js";
import { AudienceWindow } from "./AudienceWindow.js";
import { readSignal, type PresentSignal } from "./presentlink.js";

beforeAll(() => {
  window.matchMedia ??= (() => ({ addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const session = "abcdef0123456789abcdef01";
const deck = {
  record: { id: "pitch", projectSlug: null, title: "Garden pitch", path: "", updatedAt: 5, kind: "html", artifactKind: "deck" },
  kind: "html",
  page: { id: "pitch", title: "Garden pitch", kind: "deck", html: "<main data-deck><section>a</section></main>" },
};

/** The audience window, its deck frame standing in as a page window that has reported, and the presenter's end of the channel. */
async function audience(): Promise<{ box: HTMLElement; stage: HTMLElement; heard: PresentSignal[]; say: (s: PresentSignal) => void }> {
  vi.spyOn(api, "anyPage").mockResolvedValue(deck as never);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200, headers: { "content-type": "text/javascript" } }));
  const presenter = new BroadcastChannel(`kos-present:${session}`);
  const heard: PresentSignal[] = [];
  presenter.onmessage = (e) => {
    const s = readSignal(e.data);
    if (s) heard.push(s);
  };
  render(<AudienceWindow id="pitch" session={session} />);
  const el = await waitFor(() => {
    const f = document.querySelector<HTMLIFrameElement>("iframe.artifact-frame");
    if (!f) throw new Error("no frame yet");
    return f;
  });
  const pageWin = document.body.appendChild(document.createElement("iframe")).contentWindow!;
  Object.defineProperty(el.contentWindow!, "frames", { value: [pageWin], configurable: true });
  act(() => void window.dispatchEvent(new MessageEvent("message", { source: pageWin, data: { __kos: "deck", index: 0, count: 4, hosted: true } })));
  return { box: document.querySelector<HTMLElement>(".audience")!, stage: document.querySelector<HTMLElement>(".audience-stage")!, heard, say: (s) => presenter.postMessage(s) };
}

describe("the audience window", () => {
  it("hides its bar and the pointer when the mouse rests, and shows them when it moves", async () => {
    const { box } = await audience();
    vi.useFakeTimers();
    fireEvent.mouseMove(box);
    expect(box.classList.contains("is-idle")).toBe(false);
    act(() => void vi.advanceTimersByTime(3100));
    expect(box.classList.contains("is-idle")).toBe(true);
    fireEvent.mouseMove(box);
    expect(box.classList.contains("is-idle")).toBe(false);
  });

  it("goes full screen on F or a double-click, and a double-click moves nothing", async () => {
    const full = vi.fn().mockResolvedValue(undefined);
    HTMLElement.prototype.requestFullscreen = full;
    const { stage, heard } = await audience();
    fireEvent.keyDown(window, { key: "f" });
    expect(full).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
    fireEvent.click(stage, { detail: 1, clientX: 900 });
    fireEvent.click(stage, { detail: 2, clientX: 900 });
    act(() => void vi.advanceTimersByTime(400));
    expect(full).toHaveBeenCalledTimes(2);
    expect(heard.filter((s) => s.type === "moved")).toEqual([]);
  });

  it("moves on a single press, and the presenter hears it", async () => {
    const { stage, heard } = await audience();
    fireEvent.click(stage, { detail: 1, clientX: 900 });
    await waitFor(() => expect(heard).toContainEqual({ type: "moved", index: 1 }));
    expect(screen.getByText("Garden pitch")).toBeTruthy();
  });
});
