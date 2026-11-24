// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState, type ReactElement } from "react";

import { useFocusTrap } from "@kos/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./api.js";
import { FilePreview } from "./FilePreview.js";
import { CHAT_ROOM, PANEL_ROOM, panelWidthFor, usePanelDrawer, useRoomFor } from "./paneldrawer.js";

/** The page's width as a ResizeObserver says it: one observer, resized by hand. */
let resizeTo: (width: number) => void = () => undefined;
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly said: ResizeObserverCallback) {
        resizeTo = (width) => act(() => this.said([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver));
      }
      observe(): void {}
      disconnect(): void {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A sheet opened over the drawer, with its own trap, as Rename is. */
function Rename({ onClose }: { onClose: () => void }): ReactElement {
  const box = useRef<HTMLDivElement>(null);
  useFocusTrap(box, true, { onEscape: onClose });
  return (
    <div ref={box} role="dialog" aria-modal="true" aria-label="Rename">
      <input aria-label="Title" />
    </div>
  );
}

/** The chats page's shape, as far as the drawer is concerned: the toggle, the panel, a backdrop while open, and what opens over it. */
function Page(): ReactElement {
  const root = useRef<HTMLDivElement>(null);
  const fits = useRoomFor(root, PANEL_ROOM);
  const drawer = usePanelDrawer(root, fits);
  const [renaming, setRenaming] = useState(false);
  const [looking, setLooking] = useState<string | null>(null);
  return (
    <div ref={root} data-room={fits ? "column" : "drawer"}>
      <button type="button" className="chats-panel-toggle" aria-pressed={drawer.open} onClick={drawer.toggle}>
        Panel
      </button>
      {drawer.open && <div data-testid="backdrop" onClick={drawer.close} />}
      <aside className="project-panel" aria-label="School workspace" {...(drawer.open ? { role: "dialog", "aria-modal": true } : {})}>
        <button type="button">Open in Files</button>
        <button type="button" onClick={() => setRenaming(true)}>
          Rename
        </button>
        <button type="button" onClick={() => setLooking("a.md")}>
          Look
        </button>
      </aside>
      {renaming && <Rename onClose={() => setRenaming(false)} />}
      <FilePreview path={looking} quickLook onClose={() => setLooking(null)} />
    </div>
  );
}

const frame = (): Promise<void> => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
const toggle = (): HTMLElement => screen.getByRole("button", { name: "Panel" });
const isOpen = (): boolean => toggle().getAttribute("aria-pressed") === "true";

async function openNarrow(): Promise<void> {
  render(<Page />);
  resizeTo(PANEL_ROOM - 100);
  toggle().focus();
  fireEvent.click(toggle());
  await frame();
}

describe("the panel's drawer", () => {
  it("opens from the toggle, keeps the tab key in it, and shuts on Escape, the focus back on the toggle", async () => {
    await openNarrow();
    expect(isOpen()).toBe(true);
    const first = screen.getByRole("button", { name: "Open in Files" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Look" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(toggle());
  });

  it("shuts on its backdrop, and on the toggle again, the focus back on the toggle", async () => {
    await openNarrow();
    // A press on the backdrop takes the focus to nowhere before it shuts the drawer.
    (document.activeElement as HTMLElement).blur();
    fireEvent.click(screen.getByTestId("backdrop"));
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(toggle());
    fireEvent.click(toggle());
    expect(isOpen()).toBe(true);
    fireEvent.click(toggle());
    expect(isOpen()).toBe(false);
  });

  it("leaves an Escape a dialog over it took, or one for a sheet over it", async () => {
    await openNarrow();
    const taken = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    taken.preventDefault();
    act(() => void window.dispatchEvent(taken));
    expect(isOpen()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await frame();
    fireEvent.keyDown(screen.getByLabelText("Title"), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Rename" })).toBeNull();
    expect(isOpen()).toBe(true);
  });

  it("leaves the first Escape to Quick Look over it, and shuts on a second at once", async () => {
    vi.spyOn(api, "file").mockResolvedValue({ path: "a.md", size: 1, modifiedAt: 1, text: "a", language: "markdown" });
    await openNarrow();
    fireEvent.click(screen.getByRole("button", { name: "Look" }));
    expect(await screen.findByRole("dialog", { name: "Quick Look: a.md" })).toBeTruthy();
    // The keys are still in the panel, as Quick Look leaves them.
    const inPanel = screen.getByRole("button", { name: "Open in Files" });
    fireEvent.keyDown(inPanel, { key: "Escape" });
    expect(isOpen()).toBe(true);
    // Shut, though it may still be leaving: the next Escape is the drawer's.
    fireEvent.keyDown(inPanel, { key: "Escape" });
    expect(isOpen()).toBe(false);
  });

  it("is a column again, and shut, once there is room for it", async () => {
    await openNarrow();
    expect(screen.getByRole("button", { name: "Panel" }).closest("[data-room]")?.getAttribute("data-room")).toBe("drawer");
    resizeTo(PANEL_ROOM);
    expect(isOpen()).toBe(true);
    resizeTo(PANEL_ROOM + 1);
    expect(isOpen()).toBe(false);
    expect(toggle().closest("[data-room]")?.getAttribute("data-room")).toBe("column");
  });
});

describe("the panel's width", () => {
  it("is the owner's while the chat keeps its room, and gives way, not under its least, when it would not", () => {
    expect(panelWidthFor(300, 1240, 240, 160)).toBe(300);
    expect(panelWidthFor(640, 1240, 240, 160)).toBe(1240 - 240 - CHAT_ROOM);
    // The list folded: its room is the panel's to take.
    expect(panelWidthFor(640, 1240, 0, 160)).toBe(640);
    expect(panelWidthFor(300, PANEL_ROOM + 20, 240, 160)).toBe(180);
    expect(panelWidthFor(300, PANEL_ROOM - 100, 240, 160)).toBe(160);
  });

  it("is as asked before the page is laid out", () => {
    expect(panelWidthFor(420, 0, 240, 160)).toBe(420);
  });
});
