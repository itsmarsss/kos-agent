// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { askView } from "@kos/shared";

import { AskCard } from "./AskCard.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The owner's case: zooming a Google Doc out in their own Chrome. */
const args = JSON.stringify({
  intent: "Zoom the browser out so more of the document fits per screen",
  actions: [{ press: "Meta+Minus" }, { press: "Meta+Minus" }, { press: "Meta+Minus" }, { press: "Meta+Minus" }, { press: "Meta+Home" }],
});
const view = askView({
  tool: "browser.act",
  args,
  reason: "clicks, types or fills on the page, in your Chrome",
  rule: { tool: "browser.*", scope: "your-chrome:docs.google.com", project: null },
  yours: true,
});

function card(onDecide = vi.fn(), extra: Partial<Parameters<typeof AskCard>[0]> = {}) {
  const rendered = render(<AskCard view={view} tool="browser.act" args={args} asker="Docs" onDecide={onDecide} {...extra} />);
  return { ...rendered, onDecide, section: rendered.container.querySelector<HTMLElement>(".kos-ask")! };
}

describe("the approval card", () => {
  it("leads with what, where, the steps as keycaps and why", () => {
    const { container } = card();
    expect(container.querySelector(".kos-ask-who")?.textContent).toBe("Docs asks");
    expect(container.querySelector(".kos-ask-title")?.textContent).toBe("Zoom the browser out so more of the document fits per screen");
    expect(container.querySelector(".kos-ask-place")?.textContent).toBe("In your Chrome on docs.google.com");
    expect(container.querySelector(".kos-ask-favicon")?.getAttribute("src")).toBe("https://docs.google.com/favicon.ico");
    expect(container.querySelector(".kos-ask-steps")?.textContent).toBe("Press ⌘− 4 times, then ⌘Home");
    expect([...container.querySelectorAll(".keycap")].map((k) => k.textContent)).toEqual(["⌘−", "⌘Home"]);
    expect(container.querySelector(".kos-ask-risk")?.textContent).toBe("Clicks, types or fills on the page");
  });

  it("falls back to the place's mark when the site has no icon", () => {
    const { container } = card();
    fireEvent.error(container.querySelector(".kos-ask-favicon")!);
    expect(container.querySelector(".kos-ask-favicon")).toBeNull();
    expect(container.querySelector(".kos-ask-place svg")).not.toBeNull();
  });

  it("keeps the arguments folded under Details until asked, then shows them as fields", () => {
    const { container } = card();
    const toggle = screen.getByRole("button", { name: "Details" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".ask-fields")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".ask-details .tag--mono")?.textContent).toBe("browser.act");
    const fields = [...container.querySelectorAll(".ask-details-scroll > .ask-fields > .ask-field > dt")].map((d) => d.textContent);
    expect(fields).toEqual(["intent", "actions"]);
    // The actions as a numbered list, one item each.
    expect(container.querySelectorAll(".ask-value-list > li")).toHaveLength(5);
  });

  it("cuts a long string with Show all, and shows text that is not JSON as it came", () => {
    const long = "x".repeat(400);
    const { container } = render(<AskCard view={{ title: "Run it" }} tool="shell.run" args={{ command: long }} onDecide={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(container.querySelector(".ask-value")?.textContent).toBe(`${"x".repeat(240)}…Show all`);
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(container.querySelector(".ask-value")?.textContent).toBe(`${long}Show less`);
    cleanup();
    const cut = render(<AskCard view={{ title: "Run it" }} tool="shell.run" args={'{"command":"ls -la /very/long…'} onDecide={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(cut.container.querySelector(".ask-details-scroll")?.textContent).toBe('{"command":"ls -la /very/long…');
  });

  it("copies the arguments as JSON", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    card();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy JSON" }));
    });
    expect(JSON.parse(writeText.mock.calls[0]![0] as string)).toEqual(JSON.parse(args));
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("says on the remembered yes what it keeps", () => {
    const { onDecide } = card();
    const always = screen.getByRole("button", { name: "Always allow on docs.google.com" });
    fireEvent.focus(always);
    expect(screen.getByRole("tooltip").textContent).toMatch(/docs\.google\.com in your Chrome stop asking.*Settings, Permissions/);
    fireEvent.click(always);
    expect(onDecide).toHaveBeenCalledWith(true, true);
  });

  it("offers no remembered yes where the ask cannot be remembered", () => {
    render(<AskCard view={{ title: "Run: ls" }} tool="shell.run" onDecide={vi.fn()} />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Approve", "Deny"]);
  });

  it("approves on Enter and denies on Escape or ⌘⌫ when the card is focused", () => {
    const { section, onDecide } = card();
    section.focus();
    fireEvent.keyDown(section, { key: "Enter" });
    expect(onDecide).toHaveBeenLastCalledWith(true);
    fireEvent.keyDown(section, { key: "Escape" });
    expect(onDecide).toHaveBeenLastCalledWith(false);
    fireEvent.keyDown(section, { key: "Backspace", metaKey: true });
    expect(onDecide).toHaveBeenCalledTimes(3);
    expect(onDecide).toHaveBeenLastCalledWith(false);
    // A plain Backspace is nobody's no.
    fireEvent.keyDown(section, { key: "Backspace" });
    expect(onDecide).toHaveBeenCalledTimes(3);
  });

  it("leaves Enter on a button to that button", () => {
    const { onDecide } = card();
    fireEvent.keyDown(screen.getByRole("button", { name: "Deny" }), { key: "Enter" });
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("says which press is on its way and takes no other", () => {
    const { onDecide, rerender } = card();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    rerender(<AskCard view={view} tool="browser.act" args={args} onDecide={onDecide} busy />);
    expect(screen.getByRole("button", { name: "Working" })).toBeTruthy();
    for (const b of screen.getAllByRole("button").filter((b) => b.closest(".kos-ask-actions"))) expect((b as HTMLButtonElement).disabled).toBe(true);
  });

  it("reads as done or can't for a handoff", () => {
    const onDecide = vi.fn();
    render(<AskCard view={view} tool="browser.handoff" onDecide={onDecide} labels={{ yes: "Done", no: "Can't" }} noRemember />);
    expect(screen.queryByRole("button", { name: /Always/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onDecide).toHaveBeenCalledWith(true);
  });
});

describe("the approval card's sheet", () => {
  const css = readFileSync(join(__dirname, "kit.css"), "utf8");

  it("draws the buttons at one height", () => {
    expect(/\.kos-ask-actions \.btn \{[^}]*height: 32px/.test(css)).toBe(true);
  });

  it("stands the buttons one to a row, full width, on a narrow card", () => {
    const narrow = /@container \(max-width: 420px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(narrow).toMatch(/\.kos-ask-actions \{ flex-direction: column; \}/);
    expect(narrow).toMatch(/\.kos-ask-actions \.btn \{ width: 100%;/);
    expect(/\.kos-ask \{[^}]*container-type: inline-size/.test(css)).toBe(true);
  });

  it("scrolls the details inside the card rather than running off it", () => {
    expect(/\.ask-details-scroll \{[^}]*max-height: 240px; overflow: auto/.test(css)).toBe(true);
  });
});
