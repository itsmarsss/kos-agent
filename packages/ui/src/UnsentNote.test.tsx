// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UnsentNote } from "./UnsentNote.js";

afterEach(cleanup);

describe("the note under a message that was not sent", () => {
  it("says why, sends it again on Retry and takes it back on Edit, each once", () => {
    const onRetry = vi.fn();
    const onEdit = vi.fn();
    render(<UnsentNote reason="KOS is not answering." down={false} onRetry={onRetry} onEdit={onEdit} />);
    expect(screen.getByRole("alert").textContent).toContain("Not sent. KOS is not answering.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onEdit).toHaveBeenCalledOnce();
  });

  it("holds Retry while KOS is not answering", () => {
    render(<UnsentNote reason="KOS is not answering." down onRetry={vi.fn()} onEdit={vi.fn()} />);
    expect((screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
