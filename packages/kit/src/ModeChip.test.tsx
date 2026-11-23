// @vitest-environment jsdom
import type { ChatMode } from "@kos/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isModeKey, ModeChip } from "./ModeChip.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** The chip as a composer holds it: the mode in state, Shift+Tab in its box cycling it. */
function Composer({ start, told }: { start: ChatMode; told: (m: ChatMode) => void }): ReactElement {
  const [mode, setMode] = useState(start);
  const set = (m: ChatMode): void => {
    setMode(m);
    told(m);
  };
  return (
    <>
      <textarea
        aria-label="box"
        onKeyDown={(e) => {
          if (!isModeKey(e)) return;
          e.preventDefault();
          set(mode.mode === "ask" ? { mode: "auto" } : { mode: "ask" });
        }}
      />
      <ModeChip mode={mode} onChange={set} />
    </>
  );
}

describe("ModeChip", () => {
  it("goes into Auto only by a choice in its menu, and back to Ask in one press", () => {
    const told = vi.fn();
    render(<Composer start={{ mode: "ask" }} told={told} />);
    const main = screen.getByRole("button", { name: /Mode: Ask/ });
    expect(main.getAttribute("title")).toMatch(/^Ask: KOS asks you before anything risky in this chat\. Shift\+Tab/);
    // One tap in Ask opens the menu, which says what Auto does; it does not switch.
    fireEvent.click(main);
    expect(told).not.toHaveBeenCalled();
    const menu = screen.getByRole("menu");
    expect(menu.textContent).toContain("Goes ahead without asking");
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^Auto/ }));
    expect(told).toHaveBeenLastCalledWith({ mode: "auto" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("button", { name: /Mode: Auto/ }).getAttribute("title")).toMatch(/^Auto: KOS goes ahead without asking/);
    fireEvent.click(screen.getByRole("button", { name: /Mode: Auto/ }));
    expect(told).toHaveBeenLastCalledWith({ mode: "ask" });
  });

  it("cycles on Shift+Tab in the box and on no other Tab", () => {
    const told = vi.fn();
    render(<Composer start={{ mode: "ask" }} told={told} />);
    const box = screen.getByLabelText("box");
    fireEvent.keyDown(box, { key: "Tab" });
    fireEvent.keyDown(box, { key: "Tab", shiftKey: true, metaKey: true });
    expect(told).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Tab", shiftKey: true });
    expect(told).toHaveBeenLastCalledWith({ mode: "auto" });
    expect(document.querySelector(".mode-chip")?.getAttribute("data-mode")).toBe("auto");
  });

  it("counts Auto down, and reads as Ask once it has run out", () => {
    vi.useFakeTimers({ now: 1_000_000 });
    render(<ModeChip mode={{ mode: "auto", until: 1_000_000 + 90 * 60_000 }} onChange={() => undefined} />);
    expect(screen.getByRole("button", { name: /Mode: Auto · 1h 30m/ })).toBeTruthy();
    vi.setSystemTime(1_000_000 + 91 * 60_000);
    cleanup();
    render(<ModeChip mode={{ mode: "auto", until: 1_000_000 + 90 * 60_000 }} onChange={() => undefined} />);
    expect(screen.getByRole("button", { name: /Mode: Ask/ })).toBeTruthy();
  });

  it("opens a menu of how long Auto lasts, sessions, and what it never covers", () => {
    const told = vi.fn();
    render(<ModeChip mode={{ mode: "ask" }} onChange={told} />);
    fireEvent.click(screen.getByRole("button", { name: "Mode options" }));
    const menu = screen.getByRole("menu");
    expect(menu.textContent).toContain("What Auto never does");
    expect(menu.textContent).toContain("Buying or paying for anything");
    expect(menu.textContent).toContain("A device's own ask for a session");
    // Sessions are Auto's; in Ask the switch waits.
    expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Until this task finishes/ }));
    expect(told).toHaveBeenLastCalledWith({ mode: "auto", until: "task" });
  });

  it("sets sessions on Auto, keeping its bounds, and marks a running turn under Auto", () => {
    const told = vi.fn();
    const { container } = render(<ModeChip mode={{ mode: "auto", until: "task" }} onChange={told} running />);
    expect(container.querySelector(".mode-chip")?.hasAttribute("data-running")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Mode options" }));
    expect(screen.getByRole("menuitemradio", { name: /Until this task finishes/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("switch"));
    expect(told).toHaveBeenLastCalledWith({ mode: "auto", until: "task", sessions: true });
  });
});
