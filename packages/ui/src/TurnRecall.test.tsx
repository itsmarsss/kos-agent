// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { TurnRecall } from "./TurnRecall.js";

afterEach(cleanup);

describe("what the last turn was given from memory", () => {
  it("counts in the chip and names each claim with its scope when opened", () => {
    render(
      <TurnRecall
        recalled={{
          at: 1,
          projectSlug: "pantry",
          facts: [
            { id: 1, key: "name", value: "Sam", scope: "global", pinned: true, trust: "owner" },
            { id: 2, key: "shelf", value: "top left", scope: "project:pantry", pinned: false, trust: "agent" },
          ],
          events: [{ id: 9, role: "owner", text: "we moved the tea", ts: 1 }],
        }}
      />,
    );
    const chip = screen.getByRole("button");
    expect(chip.textContent).toBe("memory: 2 claims · 1 moment");
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(chip);
    expect(screen.getByText("Project in play: pantry")).toBeTruthy();
    expect(screen.getByText("everywhere · pinned")).toBeTruthy();
    expect(screen.getByText("project pantry · agent")).toBeTruthy();
    expect(screen.getByText("we moved the tea")).toBeTruthy();
  });

  it("says so when nothing matched", () => {
    render(<TurnRecall recalled={{ at: 1, projectSlug: null, facts: [], events: [] }} />);
    expect(screen.getByText("memory: nothing matched")).toBeTruthy();
  });
});
