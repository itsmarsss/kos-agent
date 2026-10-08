// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ActivityDot, fixLabel } from "./StatusDot.js";

afterEach(cleanup);

/**
 * A thread's state as a colour. The word that used to be in a chip is in
 * the tooltip, so a reader who hovers still gets it.
 */
describe("the activity dot", () => {
  it("is blue working, yellow waiting on you, red broken, green unread and grey read", () => {
    render(<ActivityDot activity="working" />);
    expect(screen.getByRole("img", { name: "working" }).className).toContain("status-dot--working");
    cleanup();
    render(<ActivityDot activity="needs-you" />);
    expect(screen.getByRole("img", { name: "needs you" }).className).toContain("status-dot--needs-you");
    cleanup();
    render(<ActivityDot activity="error" error="model unreachable" />);
    expect(screen.getByRole("img", { name: "failed: model unreachable" }).className).toContain("status-dot--error");
    cleanup();
    render(<ActivityDot activity="idle" unread />);
    expect(screen.getByRole("img", { name: "unread" }).className).toContain("status-dot--unread");
    cleanup();
    render(<ActivityDot activity="idle" />);
    expect(screen.getByRole("img", { name: "read" }).className).toContain("status-dot--read");
  });

  it("stays out of the way where only attention states are wanted", () => {
    const { container } = render(<ActivityDot activity="idle" unread quiet />);
    expect(container.querySelector(".status-dot")).toBeNull();
    cleanup();
    render(<ActivityDot activity="working" quiet />);
    expect(screen.getByRole("img", { name: "working" })).toBeTruthy();
  });

  it("says where KOS is with a failure it has a chat open for", () => {
    expect(fixLabel("working")).toBe("KOS is on it");
    expect(fixLabel("needs-you")).toBe("KOS needs you");
    expect(fixLabel("error")).toBe("KOS could not finish");
    expect(fixLabel("idle")).toBe("KOS looked at it");
  });
});
