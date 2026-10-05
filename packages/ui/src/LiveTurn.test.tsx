// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { congregationHead, LiveTurn } from "./LiveTurn.js";
import type { CongregationMember, Live } from "./progress.js";

const base: Live = { steps: [], text: "", since: Date.now() };

describe("LiveTurn states", () => {
  afterEach(cleanup);

  it("says it is thinking when nothing else is happening", () => {
    render(<LiveTurn live={base} />);
    expect(screen.getByText("Thinking")).toBeTruthy();
  });

  it("names the tool while one is running, rather than saying thinking", () => {
    render(
      <LiveTurn
        live={{
          ...base,
          steps: [
            {
              kind: "tool",
              tool: "pages.list",
              summary: "List pages",
              done: false,
              isError: false,
            },
          ],
        }}
      />,
    );
    expect(screen.getByText("Running List pages")).toBeTruthy();
    expect(screen.queryByText("Thinking")).toBeNull();
  });

  it("drops the thinking box once the reply is arriving", () => {
    // Streaming prose under a "thinking" label says something untrue about
    // what the model is doing.
    const { container } = render(
      <LiveTurn live={{ ...base, text: "Here is the answer" }} />,
    );
    expect(container.querySelector(".live-head")).toBeNull();
    expect(container.textContent).toContain("Here is the answer");
  });

  it("keeps finished tool calls visible while it thinks about the result", () => {
    const { container } = render(
      <LiveTurn
        live={{
          ...base,
          steps: [
            {
              kind: "tool",
              tool: "sql",
              summary: "SELECT 1",
              done: true,
              isError: false,
            },
          ],
        }}
      />,
    );
    expect(container.querySelector(".toolcall")?.textContent).toContain("SELECT 1");
    expect(screen.getByText("Thinking")).toBeTruthy();
  });

  /*
   * The same component the finished transcript uses. A running call that could
   * only be read as one line meant waiting for the turn to end to find out
   * what the agent had actually asked for.
   */
  it("lets a call still running be opened for its arguments", () => {
    const { container } = render(
      <LiveTurn
        live={{
          ...base,
          steps: [
            {
              kind: "tool",
              tool: "files.write",
              summary: "notes.md",
              done: false,
              isError: false,
              input: { path: "notes.md", content: "hello" },
            },
          ],
        }}
      />,
    );
    const head = container.querySelector<HTMLElement>(".toolcall-head");
    expect(head).toBeTruthy();
    fireEvent.click(head!);
    expect(container.querySelector(".toolcall")?.textContent).toContain("notes.md");
    expect(container.querySelector(".toolcall")?.textContent).toContain("hello");
  });

  it("shows what a finished call returned", () => {
    const { container } = render(
      <LiveTurn
        live={{
          ...base,
          steps: [
            {
              kind: "tool",
              tool: "sql",
              summary: "SELECT 1",
              done: true,
              isError: false,
              input: { query: "SELECT 1" },
              result: "1 row",
            },
          ],
        }}
      />,
    );
    fireEvent.click(container.querySelector<HTMLElement>(".toolcall-head")!);
    expect(container.querySelector(".toolcall")?.textContent).toContain("1 row");
  });

  it("shows a thought as it streams", () => {
    const { container } = render(
      <LiveTurn
        live={{ ...base, steps: [{ kind: "reasoning", text: "Working it out" }] }}
      />,
    );
    expect(container.querySelector(".thinking")?.textContent).toContain(
      "Working it out",
    );
  });
});

describe("joining a turn already in progress", () => {
  afterEach(cleanup);

  it("says it is still working rather than claiming to think", () => {
    render(<LiveTurn live={{ ...base, resumed: true }} />);
    expect(screen.getByText("Still working")).toBeTruthy();
  });

  it("withholds a reply it only has the middle of", () => {
    // After a reload the earlier deltas are gone, so showing what arrives next
    // would start the answer mid-sentence.
    const { container } = render(
      <LiveTurn live={{ ...base, resumed: true, text: "sentence" }} />,
    );
    expect(container.textContent).not.toContain("sentence");
    expect(screen.getByText("Still working")).toBeTruthy();
  });

  it("keeps its steps but stops saying it is working once the turn ends", () => {
    // The steps stay until the transcript that contains them arrives, so the
    // end of a turn does not flash an empty gap. What must go is the claim
    // that anything is still happening.
    const { container } = render(
      <LiveTurn
        live={{
          ...base,
          ended: true,
          steps: [
            {
              kind: "tool",
              tool: "sql",
              summary: "SELECT 1",
              done: true,
              isError: false,
            },
          ],
        }}
      />,
    );
    expect(container.querySelector(".toolcall")?.textContent).toContain("SELECT 1");
    expect(screen.queryByText("Thinking")).toBeNull();
    expect(container.querySelector(".live-dots")).toBeNull();
  });

  it("still shows tool calls it did see", () => {
    const { container } = render(
      <LiveTurn
        live={{
          ...base,
          resumed: true,
          steps: [
            { kind: "tool", tool: "sql", summary: "SELECT 1", done: true, isError: false },
          ],
        }}
      />,
    );
    expect(container.querySelector(".toolcall")?.textContent).toContain("SELECT 1");
  });
});

describe("a congregation", () => {
  afterEach(cleanup);

  const members: CongregationMember[] = [
    { id: "a", title: "Cost Angle", status: "done" },
    { id: "b", title: "Risk Angle", status: "working" },
  ];

  it("counts who is done and who is still working", () => {
    expect(congregationHead(members)).toBe("Gathering from 2 agents, 1 done, 1 working");
    expect(congregationHead([{ id: "a", title: "A", status: "done" }])).toBe(
      "Gathered from 1 agent",
    );
    expect(
      congregationHead([
        { id: "a", title: "A", status: "done" },
        { id: "b", title: "B", status: "failed" },
      ]),
    ).toBe("Gathered from 2 agents, 1 failed");
    expect(
      congregationHead([
        { id: "a", title: "A", status: "working" },
        { id: "b", title: "B", status: "failed" },
      ]),
    ).toBe("Gathering from 2 agents, 0 done, 1 working, 1 failed");
  });

  it("lists each member with a link to its chat, above the reply", () => {
    const { container } = render(
      <LiveTurn live={{ ...base, congregation: { members }, text: "Combined answer" }} />,
    );
    expect(screen.getByText("Gathering from 2 agents, 1 done, 1 working")).toBeTruthy();
    const link = screen.getByText("Risk Angle").closest("a");
    expect(link?.getAttribute("href")).toBe("#/chats/b");
    expect(container.querySelector(".chats-flag--working")?.textContent).toBe("working");
    expect(container.querySelector(".chats-badge")?.textContent).toBe("done");

    // The roster sits above the streaming reply, not in place of it.
    const roster = container.querySelector(".congregation")!;
    const bubble = container.querySelector(".bubble--kos")!;
    expect(bubble.textContent).toContain("Combined answer");
    expect(roster.compareDocumentPosition(bubble) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("marks a member that failed without hiding the others", () => {
    const { container } = render(
      <LiveTurn
        live={{
          ...base,
          congregation: {
            members: [
              { id: "a", title: "A", status: "done" },
              { id: "b", title: "B", status: "failed" },
            ],
          },
        }}
      />,
    );
    expect(container.querySelector(".chats-flag--needs-you")?.textContent).toBe("failed");
    expect(screen.getByText("Gathered from 2 agents, 1 failed")).toBeTruthy();
  });
});
