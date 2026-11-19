// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Toast, toastWords } from "./Toast.js";

afterEach(cleanup);

describe("a toast", () => {
  it("says a reference as a reader would, never as its token", () => {
    expect(toastWords("Approved @approval:2. http.fetch is running.")).toBe("Approved #2. http.fetch is running.");
    expect(toastWords("Moved to @project:[Home lab]")).toBe("Moved to Home lab");
  });

  it("offers Undo when there is one", () => {
    const undo = vi.fn();
    render(<Toast note={{ kind: "ok", text: "Archived “Groceries”.", undo }} />);
    expect(screen.getByRole("status").textContent).toContain("Archived “Groceries”.");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(undo).toHaveBeenCalledOnce();
  });
});
