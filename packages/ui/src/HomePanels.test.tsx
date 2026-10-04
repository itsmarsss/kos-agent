// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HomeData } from "./api.js";
import { Panel } from "./HomePanels.js";

/**
 * The memory and modules panels, and the decisions line in Needs you.
 *
 * A panel's job is to answer its question even when the answer is nothing,
 * so the empty states are tested as carefully as the full ones.
 */

function data(over: Partial<HomeData> = {}): HomeData {
  return {
    layout: { panels: [] },
    approvals: [],
    agents: [],
    failures: [],
    health: { checks: [] } as unknown as HomeData["health"],
    activity: [],
    projects: [],
    chats: [],
    crons: [],
    spend: { models: [] },
    memory: { claims: 0, unread: 0, extraction: true, decisions: 0, jobs: [] },
    modules: { modules: [], builtins: [{ name: "tasks", description: "", enabled: true }] },
    ...over,
  };
}

function show(kind: "memory" | "modules" | "approvals", d: HomeData, onGo = vi.fn()) {
  render(
    <Panel
      panel={{ id: kind, kind, span: "half" }}
      data={d}
      editing={false}
      onChange={() => {}}
      onOpenChat={() => {}}
      onGo={onGo}
      onDecide={() => {}}
      deciding={new Set()}
      onDismissFailure={() => {}}
      onOpenFailure={() => {}}
      onFixFailure={() => {}}
    />,
  );
  return onGo;
}

afterEach(cleanup);

describe("the memory panel", () => {
  it("says what memory holds and that its jobs are off", () => {
    show("memory", data({ memory: { claims: 12, unread: 3, extraction: true, decisions: 0, jobs: [{ id: 2, name: "kos.memory", enabled: false, lastRunAt: null }] } }));
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText("claims")).toBeTruthy();
    expect(screen.getByText(/Jobs off; reading after each turn/)).toBeTruthy();
  });

  it("names the jobs that are on and when one last ran", () => {
    show("memory", data({ memory: { claims: 1, unread: 0, extraction: false, decisions: 0, jobs: [
      { id: 2, name: "kos.memory", enabled: true, lastRunAt: Date.now() - 120_000 },
      { id: 3, name: "kos.dream", enabled: true, lastRunAt: null },
    ] } }));
    expect(screen.getByText(/Read, Tidy on, last ran 2m ago/)).toBeTruthy();
  });

  it("goes to the Memory page from its link", () => {
    const go = show("memory", data());
    screen.getByText("All →").click();
    expect(go).toHaveBeenCalledWith("memory");
  });
});

describe("the modules panel", () => {
  it("names the built-ins when there are no workspace modules", () => {
    show("modules", data());
    expect(screen.getByText(/No workspace modules. Built in: tasks/)).toBeTruthy();
  });

  it("shows each module's state, and marks one that did not come up", () => {
    show("modules", data({ modules: { builtins: [], modules: [
      { name: "browser", description: "", dir: "modules/browser", enabled: true, connected: true, tools: ["a", "b"] },
      { name: "mail", description: "", dir: "modules/mail", enabled: true, connected: false, error: "spawn failed" },
      { name: "old", description: "", dir: "modules/old", enabled: false },
    ] } }));
    expect(screen.getByText("2 tools")).toBeTruthy();
    expect(screen.getByText("not connected")).toBeTruthy();
    expect(screen.getByText("off")).toBeTruthy();
  });
});

describe("Needs you", () => {
  it("counts memory decisions beside approvals and sends you to decide", () => {
    const go = show("approvals", data({ memory: { claims: 0, unread: 0, extraction: true, decisions: 2, jobs: [] } }));
    expect(screen.getByText("2")).toBeTruthy();
    screen.getByText(/2 memory decisions/).click();
    expect(go).toHaveBeenCalledWith("memory");
    expect(screen.queryByText("Nothing is waiting on you.")).toBeNull();
  });
});
