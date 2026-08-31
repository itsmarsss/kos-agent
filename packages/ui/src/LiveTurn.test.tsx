// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LiveTurn } from "./LiveTurn.js";
import type { Live } from "./progress.js";

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
    expect(container.querySelector(".livetool")?.textContent).toContain("SELECT 1");
    expect(screen.getByText("Thinking")).toBeTruthy();
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
