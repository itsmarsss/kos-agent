// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Sidebar } from "./Sidebar.js";

afterEach(cleanup);

function show(route: Parameters<typeof Sidebar>[0]["route"], inboxCount = 0, halted = false, down = false) {
  render(
    <Sidebar
      route={route}
      status={{ halted, queueDepth: 0, crons: 0, pendingApprovals: 0, unhealthy: 0, routes: { reasoning: { provider: "openai", model: "gpt-5.5" } } }}
      down={down}
      inboxCount={inboxCount}
      busy={null}
      onSearch={vi.fn()}
      onBrowser={vi.fn()} browsing={false} onAsk={vi.fn()}
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
    expect(screen.getByText("Thinks with gpt-5.5")).toBeTruthy();
  });

  it("says what each More item does, Halt apart from the rest", () => {
    show({ name: "chats" }, 0);
    expect(screen.getByText("Save a copy of the workspace you can roll back to")).toBeTruthy();
    const halt = screen.getByRole("button", { name: /Halt KOS/ });
    expect(halt.previousElementSibling?.tagName).toBe("HR");
  });

  it("says KOS cannot be reached once it stops answering, whatever the last status said", () => {
    show({ name: "chats" }, 0, false, true);
    expect(screen.getByText("Can't reach KOS")).toBeTruthy();
    expect(screen.queryByText("Working")).toBeNull();
  });
});
