// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState, type ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { useFocusTrap } from "./useFocusTrap.js";

afterEach(cleanup);

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
