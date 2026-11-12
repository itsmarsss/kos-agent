// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Select } from "./Select.js";

afterEach(cleanup);

const OPTIONS = [
  { value: "gpt-5.5", label: "GPT-5.5" },
  { value: "gpt-5.4-mini", label: "GPT-5.4 mini" },
];

/**
 * Escape belongs to whatever is innermost: a select open in a drawer closes
 * itself and leaves the drawer, and gives the focus back to its button.
 */
describe("the select", () => {
  it("says what it holds as well as what it asks, and that it opens a list", () => {
    render(<Select value="gpt-5.4-mini" options={OPTIONS} onChange={() => undefined} label="Model" />);
    const button = screen.getByRole("button", { name: "Model" });
    expect(button.getAttribute("aria-haspopup")).toBe("listbox");
    expect(document.getElementById(button.getAttribute("aria-describedby")!)?.textContent).toBe("GPT-5.4 mini");
  });

  it("takes its own Escape, so the drawer it sits in stays open", () => {
    const drawerEscape = vi.fn();
    const heard = (e: KeyboardEvent): void => (e.key === "Escape" ? drawerEscape() : undefined);
    window.addEventListener("keydown", heard);
    try {
      render(<Select value="gpt-5.5" options={OPTIONS} onChange={() => undefined} label="Model" />);
      const button = screen.getByRole("button", { name: "Model" });
      fireEvent.click(button);
      act(() => void fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" }));
      expect(screen.queryByRole("listbox")).toBeNull();
      expect(drawerEscape).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(button);
    } finally {
      window.removeEventListener("keydown", heard);
    }
  });

  it("picks from the keys and gives the focus back", () => {
    const onChange = vi.fn();
    render(<Select value="gpt-5.5" options={OPTIONS} onChange={onChange} label="Model" />);
    const button = screen.getByRole("button", { name: "Model" });
    fireEvent.click(button);
    const list = screen.getByRole("listbox");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("gpt-5.4-mini");
    expect(document.activeElement).toBe(button);
  });
});
