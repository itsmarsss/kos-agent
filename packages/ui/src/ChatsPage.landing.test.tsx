// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api, type Conversation } from "./api.js";
import { chatLine, ChatsPage, KOS_CHAT_LINE, landingMode, LANDING_WORDS } from "./ChatsPage.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const noop = (): void => {};

function landing(composing: boolean, activeId?: string): { opened: string[] } {
  const opened: string[] = [];
  render(
    <ChatsPage
      conversations={[]}
      projects={[]}
      composing={composing}
      {...(activeId ? { activeId } : {})}
      pendingApprovals={new Set()}
      approvals={[]}
      deciding={new Set()}
      agents={[]}
      onOpenAgent={noop}
      crons={[]}
      onEditCron={noop}
      onOpen={(id) => opened.push(id)}
      onOpenProject={noop}
      onAside={noop}
      onNotice={noop}
      onChanged={noop}
      onDecide={noop}
    />,
  );
  return { opened };
}

describe("the rail's New chat", () => {
  it("starts a chat of the owner's own, never KOS's shared thread", async () => {
    const made = vi.spyOn(api, "newConversation").mockResolvedValue({ id: "c-new" } as Conversation);
    const sent = vi.spyOn(api, "message").mockResolvedValue({} as Awaited<ReturnType<typeof api.message>>);
    const routed = vi.spyOn(api, "orchestrator");
    const { opened } = landing(true);
    expect(screen.getByText(LANDING_WORDS.chat.title)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("Start a chat…"), { target: { value: "never message me after 10pm" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(opened).toEqual(["c-new"]));
    expect(made).toHaveBeenCalledOnce();
    expect(sent).toHaveBeenCalledWith("never message me after 10pm", "c-new");
    expect(routed).not.toHaveBeenCalled();
  });

  it("leaves Chats opened bare as KOS's front door", () => {
    expect(landingMode(false)).toBe("kos");
    expect(landingMode(true)).toBe("chat");
  });
});

describe("a link to a chat that is not there", () => {
  it("says so, rather than opening the landing as if it had worked", async () => {
    vi.spyOn(api, "conversations").mockResolvedValue([]);
    landing(false, "nope:owner");
    expect(await screen.findByText("No chat called “nope:owner”")).toBeTruthy();
    expect(screen.queryByText(LANDING_WORDS.kos.title)).toBeNull();
    expect(screen.getByRole("link", { name: "Back to Chats" }).getAttribute("href")).toBe("#/chats");
  });
});

describe("a chat's header line", () => {
  it("says what KOS's chat is for, never the prompt it runs on", () => {
    expect(chatLine({ kind: "orchestrator", brief: "You are KOS, the owner's root router. chats.create", projectSlug: null }, [])).toBe(KOS_CHAT_LINE);
  });

  it("gives a project's orchestrator its description, and any other chat the owner's brief", () => {
    expect(chatLine({ kind: "project", brief: "You orchestrate", projectSlug: "taxes" }, [{ slug: "taxes", description: "Filing for 2026" }])).toBe("Filing for 2026");
    expect(chatLine({ kind: "chat", brief: "Answer in French.", projectSlug: null }, [])).toBe("Answer in French.");
    expect(chatLine({ kind: "chat", brief: null, projectSlug: null }, [])).toBeNull();
  });
});
