// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { clockWords } from "@kos/shared";

import type { ChatEvent } from "./api.js";
import { excerpt, MessageTurn, turnWords } from "./MessageTurn.js";

const AT = Date.UTC(2026, 10, 18, 14, 41);
const actions = { tools: [], ask: () => undefined };
const spaced = (s: string | null | undefined): string => (s ?? "").replace(/\s/g, " ");

function turn(event: Extract<ChatEvent, { kind: "message" }>): HTMLElement {
  render(<MessageTurn event={event} turn={-1} actions={actions} linkFor={undefined} busy={false} onTurn={() => undefined} />);
  return document.querySelector<HTMLElement>(".turn")!;
}

afterEach(cleanup);

describe("a message's time in the thread", () => {
  it("sits left of the owner's bubble, hidden until the message is hovered", () => {
    const el = turn({ kind: "message", role: "you", text: "where is it", at: AT });
    const said = el.querySelector(".turn-said")!;
    expect([...said.children].map((c) => c.className)).toEqual(["msg-time", "bubble bubble--you"]);
    expect(spaced(said.querySelector(".msg-time")?.textContent)).toBe(spaced(clockWords(AT)));
    expect(el.classList.contains("is-timed")).toBe(false);
    fireEvent.pointerEnter(el, { pointerType: "mouse" });
    expect(el.classList.contains("is-timed")).toBe(true);
  });

  it("ends KOS's actions row, and shows when focus reaches the row", () => {
    const el = turn({ kind: "message", role: "kos", text: "Under the help tray.", at: AT });
    const row = el.querySelector(".acts")!;
    expect(row.lastElementChild?.className).toBe("msg-time");
    fireEvent.focus(screen.getByRole("button", { name: /^Copy KOS.s reply/ }));
    expect(el.classList.contains("is-timed")).toBe(true);
  });

  it("follows a note", () => {
    const el = turn({ kind: "message", role: "system", text: "Approved #4", at: AT });
    expect([...el.querySelector(".turn-said")!.children].map((c) => c.className)).toEqual(["bubble bubble--system", "msg-time"]);
  });

  it("is not shown at all for a message kept before messages kept their time", () => {
    for (const role of ["you", "kos", "system"] as const) {
      const el = turn({ kind: "message", role, text: "then" });
      expect(el.querySelector(".msg-time")).toBeNull();
      expect(el.textContent).not.toContain("0");
      cleanup();
    }
  });
});

describe("a message's words for its buttons", () => {
  it("tells two messages of the same minute apart by their first words", () => {
    expect(turnWords("you", undefined, "Message 3: short note number 3.").of).toBe("your message “Message 3: short note number 3.”");
    expect(excerpt("Here is a **plan** for the long weekend, day by day.")).toBe("Here is a plan for the long…");
  });
});
