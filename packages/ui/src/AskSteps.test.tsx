// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AskSteps } from "@kos/kit";

import { AgentTerminal } from "./AgentTerminal.js";
import { api, type BuildRecord, type HomeData, type PendingAction } from "./api.js";
import { LooseAsk } from "./ChatsPage.js";
import { Panel } from "./HomePanels.js";
import { InboxPage } from "./InboxPage.js";

/**
 * Every place the owner says yes shows what the yes is for. A step said by
 * its purpose ("Note: just closing the popup") is the model's account of
 * it; the keys it would press sit under it, on the row, in full.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const MECHANICS = "Type “hunter2”, press cmd+q";
const args = JSON.stringify({ intent: "Note: just closing the popup", actions: [{ action: "type", text: "hunter2" }, { action: "key", text: "cmd+q" }] });
const ask: PendingAction = { id: 7, tool: "computer.act", args, reason: null, summary: "Note: just closing the popup", mechanics: MECHANICS, conversationId: null, requestedAt: Date.now() };

/** The steps line, on the row and not in a fold. */
function stepsShown(): HTMLElement {
  const line = screen.getByText(MECHANICS);
  expect(line.classList.contains("ask-steps")).toBe(true);
  expect(line.closest("details")).toBeNull();
  return line;
}

describe("an ask's steps", () => {
  it("come from the host, or from the arguments when it sent none", () => {
    render(<AskSteps tool="computer.act" args={args} />);
    stepsShown();
    cleanup();
    const { container } = render(<AskSteps tool="files.rm" args={JSON.stringify({ path: "x" })} />);
    expect(container.textContent).toBe("");
  });

  it("wrap rather than cut", () => {
    const css = readFileSync(join(__dirname, "../../kit/src/kit.css"), "utf8");
    const rule = /\.ask-steps \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/white-space: normal/);
    expect(rule).toMatch(/overflow-wrap: anywhere/);
    expect(rule).not.toMatch(/line-clamp|nowrap|ellipsis/);
  });

  it("sit under the summary in the Inbox", () => {
    vi.spyOn(api, "approvalHistory").mockResolvedValue([]);
    render(
      <InboxPage
        data={{ approvals: [ask], decisions: [], failures: [], suggestions: [] }}
        deciding={new Set()}
        onDecide={() => {}}
        onOpenChat={() => {}}
        onDismissFailure={() => {}}
        onOpenFailure={() => {}}
        onFixFailure={() => {}}
        onChanged={() => {}}
      />,
    );
    expect(screen.getByText(/Note: just closing the popup/)).toBeTruthy();
    stepsShown();
  });

  it("sit under the summary in Needs you on Home", () => {
    const data = { approvals: [ask], memory: { claims: 0, unread: 0, extraction: true, decisions: 0, jobs: [] } } as unknown as HomeData;
    render(
      <Panel
        panel={{ id: "approvals", kind: "approvals", span: "half" }}
        data={data}
        editing={false}
        onChange={() => {}}
        onOpenChat={() => {}}
        onGo={() => {}}
        onDecide={() => {}}
        deciding={new Set()}
        onDismissFailure={() => {}}
        onOpenFailure={() => {}}
        onFixFailure={() => {}}
      />,
    );
    expect(screen.getByText(/Note: just closing the popup/)).toBeTruthy();
    stepsShown();
  });

  it("sit under the summary in a build's terminal", async () => {
    const build = { id: 3, dir: "/w", task: "t", status: "waiting", startedAt: 0, latest: "", events: [] } as unknown as BuildRecord;
    vi.spyOn(api, "build").mockResolvedValue({ build, approvals: [ask] });
    render(<AgentTerminal id={3} onClose={() => {}} onDecide={() => {}} deciding={new Set()} />);
    await screen.findByText(MECHANICS);
    stepsShown();
  });

  it("sit under the summary of an ask outside any tool card in a chat", () => {
    render(<LooseAsk ask={ask} />);
    expect(screen.getByText("Note: just closing the popup")).toBeTruthy();
    stepsShown();
  });
});
