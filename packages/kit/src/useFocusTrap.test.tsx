// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState, type ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { useFocusTrap } from "./useFocusTrap.js";

afterEach(cleanup);

function Sheet({ name, onClose, children }: { name: string; onClose: () => void; children?: ReactElement }): ReactElement {
  const box = useRef<HTMLDivElement>(null);
  useFocusTrap(box, true, { onEscape: onClose });
  return (
    <div ref={box} role="dialog" aria-label={name}>
      <button type="button">{`${name} first`}</button>
      <button type="button">{`${name} last`}</button>
      {children}
    </div>
  );
}

function Stacked(): ReactElement {
  const [drawer, setDrawer] = useState(true);
  const [dialog, setDialog] = useState(true);
  return (
    <main data-focus-home tabIndex={-1}>
      {drawer && (
        <Sheet name="Drawer" onClose={() => setDrawer(false)}>
          {dialog ? <Sheet name="Dialog" onClose={() => setDialog(false)} /> : <span />}
        </Sheet>
      )}
    </main>
  );
}

function Dialog(): ReactElement {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useFocusTrap(box, open);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      {open && (
        <div ref={box} role="dialog">
          <button type="button">First</button>
          <button type="button" disabled>
            Off
          </button>
          <button type="button" onClick={() => setOpen(false)}>
            Last
          </button>
        </div>
      )}
    </>
  );
}

const frame = (): Promise<void> => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

describe("useFocusTrap", () => {
  it("goes in, keeps the tab key inside, and gives the focus back to the opener", async () => {
    render(<Dialog />);
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    fireEvent.click(opener);
    await frame();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "First" }));
    screen.getByRole("button", { name: "Last" }).focus();
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "First" }));
    fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Last" }));
    fireEvent.click(screen.getByRole("button", { name: "Last" }));
    expect(document.activeElement).toBe(opener);
  });
});

describe("useFocusTrap, stacked", () => {
  it("lets only the sheet on top keep the tab key and hear Escape, one sheet per press", async () => {
    render(<Stacked />);
    await frame();
    const dialogLast = screen.getByRole("button", { name: "Dialog last" });
    dialogLast.focus();
    fireEvent.keyDown(dialogLast, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Dialog first" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Dialog" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Drawer" })).toBeTruthy();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Drawer" })).toBeNull();
  });

  it("leaves an Escape a field inside has already taken", async () => {
    render(<Stacked />);
    await frame();
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    event.preventDefault();
    act(() => void window.dispatchEvent(event));
    expect(screen.getByRole("dialog", { name: "Dialog" })).toBeTruthy();
  });

  it("gives the focus to the page's region when what opened it has gone", async () => {
    render(<Stacked />);
    await frame();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(document.activeElement).toBe(document.querySelector("[data-focus-home]"));
  });
});
