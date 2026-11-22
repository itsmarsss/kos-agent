// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Menu, menuPlace } from "./Menu.js";

afterEach(cleanup);

function Opener({ onRename }: { onRename: () => void }): ReactElement {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button type="button" ref={button} onClick={() => setOpen((v) => !v)}>
        More
      </button>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        anchor={button}
        label="More"
        items={[
          { label: "Rename", act: onRename },
          { label: "Off", act: () => undefined, disabled: true },
          { label: "Delete", act: () => undefined, danger: true, divided: true },
        ]}
      />
    </>
  );
}

describe("the one menu", () => {
  it("takes the focus as it opens, walks its rows by the arrows, and gives the focus back on Escape", () => {
    render(<Opener onRename={vi.fn()} />);
    const opener = screen.getByRole("button", { name: "More" });
    fireEvent.click(opener);
    const rename = screen.getByRole("menuitem", { name: "Rename" });
    expect(document.activeElement).toBe(rename);
    fireEvent.keyDown(rename, { key: "ArrowDown" });
    // A row that cannot be chosen is passed over.
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Delete" }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rename);
    fireEvent.keyDown(rename, { key: "Escape" });
    expect(document.activeElement).toBe(opener);
  });

  it("shuts as a row is chosen, then does what the row says", () => {
    const onRename = vi.fn();
    render(<Opener onRename={onRename} />);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    expect(onRename).toHaveBeenCalledOnce();
  });

  it("hangs under what opened it, and above it when there is no room below", () => {
    Object.assign(window, { innerWidth: 1000, innerHeight: 800 });
    const anchor = { top: 100, bottom: 130, left: 600, right: 640, width: 40, height: 30 } as DOMRect;
    expect(menuPlace({ width: 200, height: 150 }, anchor, undefined, "below", "end")).toEqual({ left: 440, top: 136, origin: "top right" });
    const low = { ...anchor, top: 700, bottom: 730 } as DOMRect;
    expect(menuPlace({ width: 200, height: 150 }, low, undefined, "below", "end").top).toBe(544);
    // At a point near the right edge, kept inside the window.
    expect(menuPlace({ width: 200, height: 150 }, null, { x: 950, y: 50 }, "below", "start").left).toBe(792);
  });
});
