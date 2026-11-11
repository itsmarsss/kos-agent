// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { PageSummary } from "./api.js";
import { DeckPresenter } from "./DeckPresenter.js";
import { readSignal, type PresentSignal } from "./presentlink.js";

beforeAll(() => {
  window.matchMedia ??= (() => ({ addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const record = { id: "pitch", projectSlug: null, title: "Garden pitch", path: "", updatedAt: Date.now(), kind: "html", artifactKind: "deck" } as PageSummary;
const page = { id: "pitch", title: "Garden pitch", kind: "deck" as const, html: "<main data-deck><section>a</section></main>" };

/** The presenter view, its two deck frames standing in as page windows, and the other end of its channel. */
async function presenter(audience: Window | null = null, onStale?: () => void): Promise<{ view: HTMLElement; slides: { report: (data: Record<string, unknown>) => void; told: ReturnType<typeof vi.spyOn> }[]; heard: PresentSignal[]; say: (s: PresentSignal) => void; ended: ReturnType<typeof vi.fn> }> {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200, headers: { "content-type": "text/javascript" } }));
  const ended = vi.fn();
  const session = "0123456789abcdef01234567";
  const other = new BroadcastChannel(`kos-present:${session}`);
  const heard: PresentSignal[] = [];
  other.onmessage = (e) => {
    const s = readSignal(e.data);
    if (s) heard.push(s);
  };
  render(<DeckPresenter record={record} page={page} start={1} count={4} session={session} audience={audience} onEnd={ended} {...(onStale ? { onStale } : {})} />);
  const view = screen.getByRole("dialog", { name: "Presenting Garden pitch" });
  const frames = await waitFor(() => {
    const f = [...view.querySelectorAll<HTMLIFrameElement>("iframe.artifact-frame")];
    if (f.length < 2) throw new Error("no frames yet");
    return f;
  });
  const slides = frames.map((el) => {
    const pageWin = document.body.appendChild(document.createElement("iframe")).contentWindow!;
    Object.defineProperty(el.contentWindow!, "frames", { value: [pageWin], configurable: true });
    const told = vi.spyOn(pageWin, "postMessage");
    const report = (data: Record<string, unknown>): void => act(() => void window.dispatchEvent(new MessageEvent("message", { source: pageWin, data: { __kos: "deck", count: 4, grid: false, notes: false, reading: false, hosted: true, ...data } })));
    return { report, told };
  });
  const say = (s: PresentSignal): void => other.postMessage(s);
  return { view, slides, heard, say, ended };
}

describe("the presenter view", () => {
  it("keeps its current and next slides on the place, and shows the current one's notes as text", async () => {
    const { view, slides } = await presenter();
    const [current, next] = slides;
    // Each frame, once it says where it is, is told the place: this one, and the one after it.
    current!.report({ index: 0, said: ["Open with the harvest.", "<b>not markup</b>"] });
    next!.report({ index: 0 });
    expect(current!.told).toHaveBeenCalledWith(expect.objectContaining({ __kos: "deck-do", action: "go", index: 1 }), "*");
    expect(next!.told).toHaveBeenCalledWith(expect.objectContaining({ __kos: "deck-do", action: "go", index: 2 }), "*");
    const notes = within(view).getByRole("region", { name: "Notes" });
    expect(within(notes).getByText("Open with the harvest.")).toBeTruthy();
    expect(within(notes).getByText("<b>not markup</b>")).toBeTruthy();
    expect(notes.querySelector("b")).toBeNull();
    // Named for the slide its report is of, even while the frame has yet to show the presenter's place.
    expect(within(notes).getByText("Notes, slide 1")).toBeTruthy();
    current!.report({ index: 1, said: [] });
    expect(within(notes).getByText("No notes for this slide.")).toBeTruthy();
    expect(within(notes).getByText("Notes, slide 2")).toBeTruthy();
    // To the last: the next slide says the deck ends, and next stops.
    fireEvent.click(within(view).getByRole("button", { name: "Next slide" }));
    fireEvent.keyDown(view, { key: "End" });
    expect(within(view).getByText("Slide 4 of 4")).toBeTruthy();
    expect(within(view).getByText("End of the deck")).toBeTruthy();
    expect((within(view).getByRole("button", { name: "Next slide" }) as HTMLButtonElement).disabled).toBe(true);
    expect(current!.told).toHaveBeenLastCalledWith(expect.objectContaining({ __kos: "deck-do", action: "go", index: 3 }), "*");
  });

  it("raises a slide frame's trouble once, in its own head", async () => {
    const { view } = await presenter();
    const frames = [...view.querySelectorAll<HTMLIFrameElement>("iframe.artifact-frame")];
    for (const el of frames) {
      const pageWin = (el.contentWindow!.frames as unknown as Window[])[0]!;
      act(() => void window.dispatchEvent(new MessageEvent("message", { source: pageWin, data: { __kos: "error", message: "colour is not defined" } })));
    }
    const said = within(view).getAllByRole("alert");
    expect(said).toHaveLength(1);
    expect(said[0]!.textContent).toBe("The page hit an error: colour is not defined");
    expect(within(view).queryByText("Fix with KOS")).toBeNull();
  });

  it("makes the dashboard under it inert while open, and gives it back", async () => {
    const app = document.body.appendChild(Object.assign(document.createElement("div"), { id: "root" }));
    const { view } = await presenter();
    expect(app.hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(view);
    cleanup();
    expect(app.hasAttribute("inert")).toBe(false);
    app.remove();
  });

  it("takes the keys a presenter reaches for, leaving a control its own Space", async () => {
    const { view, ended } = await presenter();
    const at = (): string => within(view).getByText(/^Slide \d of 4$/).textContent!;
    fireEvent.keyDown(view, { key: "PageDown" });
    expect(at()).toBe("Slide 3 of 4");
    fireEvent.keyDown(view, { key: " ", shiftKey: true });
    expect(at()).toBe("Slide 2 of 4");
    fireEvent.keyDown(view, { key: "Home" });
    expect(at()).toBe("Slide 1 of 4");
    fireEvent.keyDown(within(view).getByRole("button", { name: "End" }), { key: " " });
    expect(at()).toBe("Slide 1 of 4");
    // What opens over the presenter (a palette, a dialog) keeps its keys.
    const over = document.body.appendChild(document.createElement("input"));
    fireEvent.keyDown(over, { key: "ArrowRight" });
    fireEvent.keyDown(over, { key: "Escape" });
    expect(at()).toBe("Slide 1 of 4");
    expect(ended).not.toHaveBeenCalled();
    over.remove();
    // A shortcut with a modifier is the browser's.
    fireEvent.keyDown(view, { key: "ArrowRight", metaKey: true });
    expect(at()).toBe("Slide 1 of 4");
    fireEvent.keyDown(view, { key: "Escape" });
    expect(ended).toHaveBeenCalledWith(0);
  });

  it("keeps time, and holds and resets it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["performance", "setInterval", "clearInterval"] });
    const { view } = await presenter();
    const time = within(view).getByRole("timer");
    expect(time.textContent).toBe("0:00");
    act(() => void vi.advanceTimersByTime(65_000));
    expect(time.textContent).toBe("1:05");
    fireEvent.click(within(view).getByRole("button", { name: "Pause the timer" }));
    act(() => void vi.advanceTimersByTime(30_000));
    expect(time.textContent).toBe("1:05");
    fireEvent.click(within(view).getByRole("button", { name: "Reset the timer" }));
    expect(time.textContent).toBe("0:00");
    fireEvent.click(within(view).getByRole("button", { name: "Resume the timer" }));
    act(() => void vi.advanceTimersByTime(3_000));
    expect(time.textContent).toBe("0:03");
  });

  it("keeps the audience window on its place, follows it when it moves, and closes it on End", async () => {
    const audience = { closed: false, close: vi.fn() };
    const stale = vi.fn();
    const { view, heard, say, ended } = await presenter(audience as unknown as Window, stale);
    say({ type: "hello", version: record.updatedAt });
    await waitFor(() => expect(within(view).getByText("Audience window open")).toBeTruthy());
    // The place, with the version presented, for the audience to load the same one.
    expect(heard).toContainEqual({ type: "go", index: 1, version: record.updatedAt });
    expect(stale).not.toHaveBeenCalled();
    fireEvent.keyDown(view, { key: "ArrowRight" });
    await waitFor(() => expect(heard).toContainEqual({ type: "go", index: 2, version: record.updatedAt }));
    // An audience window showing a newer version than this: the presenter reads the deck again, once for it; an older one is the audience's to catch up.
    say({ type: "hello", version: record.updatedAt + 1 });
    await waitFor(() => expect(stale).toHaveBeenCalledTimes(1));
    say({ type: "hello", version: record.updatedAt + 1 });
    say({ type: "hello", version: record.updatedAt - 1 });
    await new Promise((r) => setTimeout(r, 50));
    expect(stale).toHaveBeenCalledTimes(1);
    // What went wrong over there is said here, as text.
    say({ type: "trouble", words: "The audience window could not load the deck: <b>gone</b>" });
    await waitFor(() => expect(within(view).getByRole("alert").textContent).toBe("The audience window could not load the deck: <b>gone</b>"));
    // A key in the audience window moved its deck: the presenter follows.
    say({ type: "moved", index: 0 });
    await waitFor(() => expect(within(view).getByText("Slide 1 of 4")).toBeTruthy());
    fireEvent.click(within(view).getByRole("button", { name: "End" }));
    await waitFor(() => expect(heard).toContainEqual({ type: "end" }));
    expect(audience.close).toHaveBeenCalled();
    expect(ended).toHaveBeenCalledWith(0);
  });

  it("says when the audience window is closed or blocked, and opens it again from a press", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { view } = await presenter(null);
    expect(within(view).getByText("Pop-up blocked")).toBeTruthy();
    const again = { closed: false, close: vi.fn() };
    open.mockReturnValue(again as unknown as Window);
    fireEvent.click(within(view).getByRole("button", { name: "Open audience window" }));
    expect(String(open.mock.calls[0]![0])).toMatch(/#\/audience\/pitch\/0123456789abcdef01234567$/);
    // The audience window keeps no way back into this one.
    expect((again as { opener?: unknown }).opener).toBeNull();
    expect(within(view).getByText("Opening the audience window")).toBeTruthy();
    // The owner closes it: there is no event for that, so the presenter looks.
    again.closed = true;
    await waitFor(() => expect(within(view).getByText("No audience window")).toBeTruthy(), { timeout: 2500 });
  });
});
