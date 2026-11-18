// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatWords } from "./ChatWords.js";
import { LiveTurn } from "./LiveTurn.js";
import type { Live } from "./progress.js";

const DRAFT = "```kos:email\nto: sam@example.com\n---\nHi Sam\n```";
const actions = { tools: ["mcp.gmail.send_email"], ask: vi.fn() };

afterEach(cleanup);

describe("who a block's Send is offered to", () => {
  it("is KOS's words alone", () => {
    render(<ChatWords role="kos" text={DRAFT} actions={actions} />);
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
    cleanup();
    for (const role of ["you", "system"]) {
      render(<ChatWords role={role} text={DRAFT} actions={actions} />);
      expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
      expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
      cleanup();
    }
  });

  it("is never a running turn's, where the owner's own words are a step too", () => {
    const live: Live = { since: Date.now(), steps: [{ kind: "said", text: DRAFT }], text: DRAFT };
    render(<LiveTurn live={live} />);
    expect(screen.getAllByRole("button", { name: "Copy" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });
});
