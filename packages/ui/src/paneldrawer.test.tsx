// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PANEL_ROOM, usePanelDrawer, useRoomFor } from "./paneldrawer.js";

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

/** The chats page's shape, as far as the drawer is concerned: the toggle, the panel, a backdrop while open. */
function Page(): ReactElement {
  const root = useRef<HTMLDivElement>(null);
  const fits = useRoomFor(root, PANEL_ROOM);
  const drawer = usePanelDrawer(root, fits);
  return (
    <div ref={root} data-room={fits ? "column" : "drawer"}>
      <button type="button" className="chats-panel-toggle" aria-pressed={drawer.open} onClick={drawer.toggle}>
        Panel
      </button>
      {drawer.open && <div data-testid="backdrop" onClick={drawer.close} />}
      <aside className="project-panel" aria-label="School workspace" {...(drawer.open ? { role: "dialog", "aria-modal": true } : {})}>
        <button type="button">Open in Files</button>
        <button type="button">Colour</button>
      </aside>
      <div role="dialog" aria-modal="true" aria-label="Rename">
        <input aria-label="Title" />
      </div>
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
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Colour" }));
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

  it("leaves an Escape a dialog over it took, or one pressed inside another dialog", async () => {
    await openNarrow();
    const taken = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    taken.preventDefault();
    act(() => void window.dispatchEvent(taken));
    expect(isOpen()).toBe(true);
    fireEvent.keyDown(screen.getByLabelText("Title"), { key: "Escape" });
    expect(isOpen()).toBe(true);
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
