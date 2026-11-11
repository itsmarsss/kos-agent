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
  it("says it is up before the deck is read, and tells the presenter when it cannot read it", async () => {
    vi.spyOn(api, "anyPage").mockRejectedValue(new Error("not found"));
    const presenter = new BroadcastChannel(`kos-present:${session}`);
    const heard: PresentSignal[] = [];
    presenter.onmessage = (e) => {
      const s = readSignal(e.data);
      if (s) heard.push(s);
    };
    render(<AudienceWindow id="pitch" session={session} />);
    await waitFor(() => expect(heard).toContainEqual({ type: "hello" }));
    await waitFor(() => expect(heard).toContainEqual({ type: "trouble", words: "The audience window could not load the deck: not found" }));
    expect(screen.getByRole("alert").textContent).toBe("not found");
    presenter.close();
  });

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

  it("goes full screen on F or its button, never on a click", async () => {
    const full = vi.fn().mockResolvedValue(undefined);
    HTMLElement.prototype.requestFullscreen = full;
    const { stage } = await audience();
    fireEvent.keyDown(window, { key: "f" });
    expect(full).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /Full screen/ }));
    expect(full).toHaveBeenCalledTimes(2);
    fireEvent.click(stage, { detail: 1, clientX: 900 });
    fireEvent.click(stage, { detail: 2, clientX: 900 });
    expect(full).toHaveBeenCalledTimes(2);
  });

  it("says which version it shows, and reads the deck again for the one the presenter presents, once", async () => {
    const { heard, say } = await audience();
    await waitFor(() => expect(heard).toContainEqual({ type: "hello", version: 5 }));
    const read = vi.mocked(api.anyPage);
    read.mockResolvedValue({ ...deck, record: { ...deck.record, updatedAt: 9 } } as never);
    say({ type: "go", index: 0, version: 9 });
    await waitFor(() => expect(heard).toContainEqual({ type: "hello", version: 9 }));
    expect(read).toHaveBeenCalledTimes(2);
    // A version it cannot get is asked for once.
    say({ type: "go", index: 0, version: 12 });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
    say({ type: "go", index: 1, version: 12 });
    await new Promise((r) => setTimeout(r, 50));
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("moves from where it is, however fast the presses come", async () => {
    const { stage, heard } = await audience();
    // Three presses in one go, before any of them has drawn: each moves on from the last.
    act(() => {
      for (let i = 0; i < 3; i++) stage.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 900, detail: 1 }));
    });
    await waitFor(() => expect(heard.filter((s) => s.type === "moved")).toEqual([1, 2, 3].map((index) => ({ type: "moved", index }))));
  });

  it("takes the press that brings the window forward as that alone", async () => {
    const { stage, heard } = await audience();
    act(() => void window.dispatchEvent(new FocusEvent("focus")));
    fireEvent.click(stage, { detail: 1, clientX: 900 });
    await new Promise((r) => setTimeout(r, 400));
    expect(heard.filter((s) => s.type === "moved")).toEqual([]);
    await new Promise((r) => setTimeout(r, 200));
    fireEvent.click(stage, { detail: 1, clientX: 900 });
    await waitFor(() => expect(heard).toContainEqual({ type: "moved", index: 1 }));
  });

  it("moves at once on a press, forward on the right and back on the left third, and the presenter hears it", async () => {
    const { stage, heard } = await audience();
    vi.spyOn(stage, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 1200, height: 700, right: 1200, bottom: 700, x: 0, y: 0, toJSON: () => ({}) });
    const moves = (): PresentSignal[] => heard.filter((s) => s.type === "moved");
    fireEvent.click(stage, { detail: 1, clientX: 900 });
    await waitFor(() => expect(moves()).toEqual([{ type: "moved", index: 1 }]));
    fireEvent.click(stage, { detail: 2, clientX: 900 });
    await waitFor(() => expect(moves()).toEqual([{ type: "moved", index: 1 }, { type: "moved", index: 2 }]));
    fireEvent.click(stage, { detail: 1, clientX: 100 });
    await waitFor(() => expect(moves().at(-1)).toEqual({ type: "moved", index: 1 }));
    expect(screen.getByText("Garden pitch")).toBeTruthy();
  });
});
