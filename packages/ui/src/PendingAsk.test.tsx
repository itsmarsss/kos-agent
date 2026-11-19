// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentTerminal } from "./AgentTerminal.js";
import { api, type BuildRecord, type HomeData, type PendingAction } from "./api.js";
import { Panel } from "./HomePanels.js";
import { InboxPage } from "./InboxPage.js";
import { PendingAsk, pendingView } from "./PendingAsk.js";
import { secretsApi } from "./secrets.js";
import { ToolCall } from "./ToolCall.js";

/**
 * Every place the owner says yes shows what the yes is for, on one card. A
 * step said by its purpose ("Note: just closing the popup") is the model's
 * account of it; the keys it would press are listed under it, in full.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const STEPS = "Type “hunter2”Press ⌘Q";
const args = JSON.stringify({ intent: "Note: just closing the popup", actions: [{ action: "type", text: "hunter2" }, { action: "key", text: "cmd+q" }] });
const ask: PendingAction = { id: 7, tool: "computer.act", args, reason: null, summary: "Note: just closing the popup", conversationId: null, requestedAt: Date.now() };

/** The card, its title and its steps, not in a fold. */
function cardShown(): HTMLElement {
  // Titled by what it acts on; the model's account is KOS's words, apart; the steps lead.
  const said = screen.getByText(/Note: just closing the popup/);
  expect(said.classList.contains("kos-ask-said")).toBe(true);
  const card = said.closest<HTMLElement>(".kos-ask")!;
  expect(card.querySelector(".kos-ask-title")?.textContent).toBe("Use your Mac");
  const steps = card.querySelector(".kos-ask-steps")!;
  expect(steps.textContent).toBe(STEPS);
  expect(steps.closest(".collapse")).toBeNull();
  return card;
}

describe("an ask's card", () => {
  it("is laid out from the arguments, titled by the host's words where it sent them", () => {
    expect(pendingView({ ...ask, title: "Close the popup on Notes" }).title).toBe("Close the popup on Notes");
    expect(pendingView(ask).title).toBe("Use your Mac");
    expect(pendingView(ask).said).toBe("Note: just closing the popup");
    expect(pendingView({ ...ask, rule: { tool: "computer.act", scope: null, project: null } }).always).toBe("Always allow");
    expect(pendingView(ask).always).toBeUndefined();
  });

  it("says a handoff is done or can't be, never kept", () => {
    const onDecide = vi.fn();
    render(<PendingAsk ask={{ ...ask, tool: "browser.handoff", args: JSON.stringify({ reason: "sign in" }) }} deciding={new Set()} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onDecide).toHaveBeenCalledWith(7, true);
  });

  it("is the Inbox's", () => {
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
    cardShown();
  });

  it("is Needs you's on Home", () => {
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
    expect(cardShown().classList.contains("kos-ask--compact")).toBe(true);
  });

  it("is a build terminal's", async () => {
    const build = { id: 3, dir: "/w", task: "t", status: "waiting", startedAt: 0, latest: "", events: [] } as unknown as BuildRecord;
    vi.spyOn(api, "build").mockResolvedValue({ build, approvals: [ask] });
    render(<AgentTerminal id={3} onClose={() => {}} onDecide={() => {}} deciding={new Set()} />);
    await screen.findByText(/Note: just closing the popup/);
    cardShown();
  });

  it("is a tool call's in a chat, while it waits, and decides by the pending id", () => {
    const onDecide = vi.fn();
    const event = { kind: "tool" as const, name: "computer.act", summary: "Note: just closing the popup", args: JSON.parse(args) as Record<string, unknown>, pendingId: "7", result: "queued" };
    render(<ToolCall event={event} waiting ask={ask} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onDecide).toHaveBeenCalledWith("7", true);
    cleanup();
    // Decided: no card, whatever the page still holds.
    render(<ToolCall event={event} ask={ask} onDecide={onDecide} />);
    expect(document.querySelector(".kos-ask")).toBeNull();
  });

  it("is read for a tool call still waiting whose ask the page does not have yet", async () => {
    vi.spyOn(api, "approvals").mockResolvedValue([ask]);
    const event = { kind: "tool" as const, name: "computer.act", summary: "Note: just closing the popup", args: JSON.parse(args) as Record<string, unknown>, pendingId: "7", result: "queued" };
    render(<ToolCall event={event} waiting onDecide={() => {}} />);
    expect(await screen.findByRole("button", { name: "Approve" })).toBeTruthy();
  });

  it("offers no Always for an ask the host says always asks", () => {
    expect(pendingView({ ...ask, asksAlways: true, rule: { tool: "computer.act", scope: null, project: null } }).always).toBeUndefined();
  });
});

describe("a request for a secret", () => {
  const request: PendingAction = { id: 9, tool: "secrets.request", args: JSON.stringify({ kind: "apikey", label: "Stripe", why: "to read the balance", since: 1 }), reason: null, summary: "", conversationId: null, requestedAt: Date.now() };

  it("opens the new secret's sheet with its kind and label, and answers once it is saved", async () => {
    vi.spyOn(secretsApi, "status").mockResolvedValue({ state: "ready", slots: ["keyfile"], scrubbed: 0 });
    const add = vi.spyOn(secretsApi, "create").mockResolvedValue({ handle: "stripe-0a1b" });
    const onDecide = vi.fn();
    render(<PendingAsk ask={request} deciding={new Set()} onDecide={onDecide} />);
    expect(screen.getByText("Add an API key for Stripe, for KOS to use without seeing it")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Always/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add it" }));
    // Nothing is approved by the press itself: only a saved secret answers the ask.
    expect(onDecide).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Label", { exact: false }) as HTMLInputElement).value).toBe("Stripe");
    fireEvent.change(screen.getByLabelText(/^Token/), { target: { value: "sk_test_from_the_sheet_000" } });
    fireEvent.click(screen.getByRole("button", { name: "Add secret" }));
    await vi.waitFor(() => expect(onDecide).toHaveBeenCalledWith(9, true));
    expect(add.mock.calls[0]![0]).toMatchObject({ kind: "apikey", label: "Stripe" });
  });
});

