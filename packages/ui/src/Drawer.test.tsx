// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState, type ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { Drawer } from "./Drawer.js";
import { Modal } from "./Modal.js";

afterEach(cleanup);

const frame = (): Promise<void> => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

function Page({ sheet }: { sheet: "drawer" | "modal" }): ReactElement {
  const [open, setOpen] = useState(false);
  const Sheet = sheet === "drawer" ? Drawer : Modal;
  return (
    <main data-focus-home tabIndex={-1}>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <button type="button">Behind</button>
      <Sheet open={open} title="Sheet" onClose={() => setOpen(false)}>
        <input aria-label="Name" />
        <button type="button">Save</button>
      </Sheet>
    </main>
  );
}

describe.each(["drawer", "modal"] as const)("the %s's focus", (sheet) => {
  it("goes in on open, stays in on Tab, shuts on Escape and goes back to the opener", async () => {
    render(<Page sheet={sheet} />);
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    fireEvent.click(opener);
    await frame();
    // The body's first control, not the head's Close and not the page behind.
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Name" }));
    screen.getByRole("button", { name: "Save" }).focus();
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
    fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Save" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await frame();
    expect(document.activeElement).toBe(opener);
  });
});
