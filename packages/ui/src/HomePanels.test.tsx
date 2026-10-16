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
    runs: [],
    health: { checks: [] } as unknown as HomeData["health"],
    activity: [],
    pulse: [],
    projects: [],
    map: [],
    chats: [],
    crons: [],
    upcoming: [],
    spend: { models: [], byDay: [] },
    memory: { claims: 0, unread: 0, extraction: true, decisions: 0, jobs: [] },
    modules: { modules: [], builtins: [{ name: "tasks", description: "", enabled: true }] },
    ...over,
  };
}

function show(kind: "memory" | "modules" | "approvals" | "pulse" | "map" | "failures" | "schedule" | "spend", d: HomeData, onGo = vi.fn()) {
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

/*
 * The chart panels. Each must say when there is nothing to draw, and when
 * there is, carry its numbers somewhere a reader can get at them.
 */
describe("the charts", () => {
  it("draws the day as bars with the figures behind them, or says the day was quiet", () => {
    show("pulse", data());
    expect(screen.getByText("Nothing ran in the last day.")).toBeTruthy();
    cleanup();
    const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    show("pulse", data({ pulse: [{ hour, calls: 4, errors: 1 }] }));
    expect(screen.getByText("4 tool calls, 1 failed")).toBeTruthy();
    expect(screen.getByTitle(/4 calls, 1 failed/)).toBeTruthy();
    expect(document.querySelectorAll(".chart-col")).toHaveLength(24);
  });

  it("offers to open the chat KOS already has on a failure instead of starting another", () => {
    const failure = { key: "cron:1", label: "Nightly", streak: 2, error: "boom", since: Date.now(), lastAt: Date.now() };
    show("failures", data({ health: { ok: false, failing: [failure], recent: { total: 2, errors: 2, rate: 1 } } }));
    expect(screen.getByText("Fix")).toBeTruthy();
    cleanup();
    show("failures", data({ health: { ok: false, failing: [{ ...failure, fixing: { conversationId: "c9", activity: "working" } }], recent: { total: 2, errors: 2, rate: 1 } } }));
    expect(screen.queryByText("Fix")).toBeNull();
    expect(screen.getByText("Open").getAttribute("title")).toBe("KOS is on it");
    expect(screen.getByRole("img", { name: "working" })).toBeTruthy();
  });

  it("puts every recent run on the strip, coloured by how it went", () => {
    show("failures", data({
      health: { ok: true, failing: [], recent: { total: 2, errors: 1, rate: 0.5 } },
      runs: [
        { id: 2, kind: "cron", ref: "digest", status: "error", error: "timed out", startedAt: Date.now() },
        { id: 1, kind: "cron", ref: "digest", status: "ok", error: null, startedAt: Date.now() - 60_000 },
      ],
    }));
    const ticks = document.querySelectorAll(".chart-tick");
    expect(ticks).toHaveLength(2);
    // Oldest on the left.
    expect(ticks[0]?.className).toContain("chart-tick--ok");
    expect(ticks[1]?.className).toContain("chart-tick--danger");
    expect(ticks[1]?.getAttribute("title")).toContain("timed out");
  });

  it("maps modules on one side of KOS and projects on the other, each with its state", () => {
    const go = show("map", data({
      projects: [{ slug: "garden", name: "Garden", type: "tracker", status: "active", lastTouchedAt: 0 }, { slug: "old", name: "Old", type: "tracker", status: "archived", lastTouchedAt: 0 }],
      map: [{ slug: "garden", threads: 2, working: 1, needsYou: 0, jobs: 1 }],
      modules: { builtins: [], modules: [{ name: "mail", description: "", dir: "m", enabled: true, connected: false, error: "down" }] },
    }));
    expect(screen.getByText("Garden")).toBeTruthy();
    expect(screen.queryByText("Old")).toBeNull();
    expect(screen.getByText("2 threads · 1 job · 1 working")).toBeTruthy();
    expect(screen.getByText("not connected")).toBeTruthy();
    expect(screen.getByText("1 working")).toBeTruthy();
    screen.getByText("mail").closest("g")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(go).toHaveBeenCalledWith("settings", "modules");
    expect(screen.getByText("Garden").closest("a")?.getAttribute("href")).toBe("#/project/garden");
  });

  it("marks on the day line when each job is due, and says so on its row", () => {
    const at = Date.now() + 2 * 3_600_000;
    show("schedule", data({
      crons: [{ id: 7, name: "Digest", schedule: "0 9 * * *", type: "self_prompt", enabled: true }],
      upcoming: [{ id: 7, name: "Digest", at }],
    }));
    expect(document.querySelectorAll(".chart-dayline-run")).toHaveLength(1);
    expect(screen.queryByText("0 9 * * *")).toBeNull();
    expect(document.querySelector(".chart-dayline-run")?.getAttribute("title")).toContain("Digest at");
  });

  it("splits spend by day and by model", () => {
    show("spend", data({ spend: {
      models: [
        { provider: "anthropic", model: "big", inputTokens: 300, outputTokens: 100, calls: 2 },
        { provider: "anthropic", model: "small", inputTokens: 50, outputTokens: 50, calls: 9 },
      ],
      byDay: [],
    } }));
    expect(document.querySelectorAll(".chart-col")).toHaveLength(7);
    expect(screen.getByText("big")).toBeTruthy();
    expect(screen.getByText("80%")).toBeTruthy();
    expect(screen.getByText("20%")).toBeTruthy();
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
