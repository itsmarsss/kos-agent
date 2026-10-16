// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Decision } from "./Decision.js";

afterEach(cleanup);

/**
 * The same buttons everywhere, with the words changed where "Approve" is
 * not what happens: a handoff is done, not approved, and is never kept.
 */
describe("the decision buttons", () => {
  it("approve, always and deny by default", () => {
    const onDecide = vi.fn();
    render(<Decision id={3} deciding={new Set()} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole("button", { name: "Always" }));
    expect(onDecide).toHaveBeenCalledWith(3, true, true);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(onDecide).toHaveBeenCalledWith(3, false);
  });

  it("reads as done or can't for a handoff, with no always", () => {
    const onDecide = vi.fn();
    render(<Decision id={4} deciding={new Set()} onDecide={onDecide} labels={{ yes: "Done", no: "Can't" }} noRemember />);
    expect(screen.queryByRole("button", { name: "Always" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onDecide).toHaveBeenCalledWith(4, true);
    expect(screen.getByRole("button", { name: "Can't" })).toBeTruthy();
  });
});
