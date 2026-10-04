// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Sidebar } from "./Sidebar.js";

afterEach(cleanup);

function show(route: Parameters<typeof Sidebar>[0]["route"], inboxCount = 0, halted = false) {
  render(
    <Sidebar
      route={route}
      status={{ halted, queueDepth: 0, crons: 0, pendingApprovals: 0, unhealthy: 0, routes: { reasoning: { provider: "openai", model: "gpt-5.5" } } }}
      inboxCount={inboxCount}
      busy={null}
      onSearch={vi.fn()}
      onRefresh={vi.fn()}
      onSnapshot={vi.fn()}
      onOpenWorkspace={vi.fn()}
      onCopyWorkspace={vi.fn()}
      onToggleKill={vi.fn()}
    />,
  );
}

describe("the sidebar", () => {
  it("marks where you are, and counts what waits in the inbox", () => {
    show({ name: "crons" }, 3);
    const runs = screen.getByRole("link", { name: "Runs" });
    expect(runs.getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Chats" }).getAttribute("aria-current")).toBeNull();
    expect(screen.getByRole("link", { name: /Inbox/ }).textContent).toContain("3");
  });

  it("says plainly when KOS is halted, and which model answers", () => {
    show({ name: "chats" }, 0, true);
    expect(screen.getByText("Halted")).toBeTruthy();
    expect(screen.getByText("gpt-5.5")).toBeTruthy();
  });
});
