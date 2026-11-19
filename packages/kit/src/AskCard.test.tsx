// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { askView } from "@kos/shared";

import { ASK_SETTLE_MS, AskCard } from "./AskCard.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** The card has sat still on screen long enough for a press to be meant for it. */
function settle(): void {
  vi.setSystemTime(Date.now() + ASK_SETTLE_MS);
}

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
    // Titled quietly by what it acts on; the steps lead; the model's words are KOS's, apart.
    expect(container.querySelector(".kos-ask-title--quiet")?.textContent).toBe("Act on the page");
    expect(container.querySelector(".kos-ask-said")?.textContent).toBe("KOS says: “Zoom the browser out so more of the document fits per screen”");
    expect(container.querySelector(".kos-ask-place")?.textContent).toBe("In your Chrome on docs.google.com");
    // Never a site's own icon: nothing is fetched from where the agent points.
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".kos-ask-steps")?.textContent).toBe("Press ⌘− 4 times, then ⌘Home");
    expect([...container.querySelectorAll(".keycap")].map((k) => k.textContent)).toEqual(["⌘−", "⌘Home"]);
    expect(container.querySelector(".kos-ask-risk")?.textContent).toBe("Clicks, types or fills on the page");
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
    settle();
    fireEvent.click(always);
    expect(onDecide).toHaveBeenCalledWith(true, true);
  });

  it("offers no remembered yes where the ask cannot be remembered", () => {
    render(<AskCard view={{ title: "Run: ls" }} tool="shell.run" onDecide={vi.fn()} />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Approve", "Deny"]);
  });

  it("approves on Enter only when the focus came by the keyboard, and once", () => {
    const { section, onDecide } = card();
    settle();
    section.focus();
    // Focused by a click (not :focus-visible): Enter is no yes.
    vi.spyOn(section, "matches").mockImplementation((q: string) => q !== ":focus-visible");
    fireEvent.keyDown(section, { key: "Enter" });
    expect(onDecide).not.toHaveBeenCalled();
    vi.spyOn(section, "matches").mockImplementation((q: string) => q === ":focus-visible");
    // A key held down repeats; the repeat sends nothing.
    fireEvent.keyDown(section, { key: "Enter", repeat: true });
    expect(onDecide).not.toHaveBeenCalled();
    fireEvent.keyDown(section, { key: "Enter" });
    fireEvent.keyDown(section, { key: "Enter" });
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenLastCalledWith(true);
  });

  it("denies on Escape or ⌘⌫ on the card itself, not on what is inside it", () => {
    const one = card();
    settle();
    fireEvent.keyDown(screen.getByRole("button", { name: "Details" }), { key: "Escape" });
    expect(one.onDecide).not.toHaveBeenCalled();
    fireEvent.keyDown(one.section, { key: "Backspace" });
    expect(one.onDecide).not.toHaveBeenCalled();
    fireEvent.keyDown(one.section, { key: "Escape" });
    expect(one.onDecide).toHaveBeenLastCalledWith(false);
    cleanup();
    const two = card();
    settle();
    fireEvent.keyDown(two.section, { key: "Backspace", metaKey: true });
    expect(two.onDecide).toHaveBeenCalledWith(false);
  });

  it("offers no Approve for an ask too long to have been sent whole", () => {
    const { section, onDecide } = card(vi.fn(), { view: { ...view, tooLong: true } });
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Always/ })).toBeNull();
    expect(screen.getByText(/Open it in the dashboard's Inbox/)).toBeTruthy();
    vi.spyOn(section, "matches").mockReturnValue(true);
    fireEvent.keyDown(section, { key: "Enter" });
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("leaves Enter on a button to that button", () => {
    const { onDecide } = card();
    fireEvent.keyDown(screen.getByRole("button", { name: "Deny" }), { key: "Enter" });
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("says which press is on its way and takes no other", () => {
    const { onDecide, rerender } = card();
    settle();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    rerender(<AskCard view={view} tool="browser.act" args={args} onDecide={onDecide} busy />);
    expect(screen.getByRole("button", { name: "Working" })).toBeTruthy();
    for (const b of screen.getAllByRole("button").filter((b) => b.closest(".kos-ask-actions"))) expect((b as HTMLButtonElement).disabled).toBe(true);
  });

  it("reads as done or can't for a handoff", () => {
    const onDecide = vi.fn();
    render(<AskCard view={view} tool="browser.handoff" onDecide={onDecide} labels={{ yes: "Done", no: "Can't" }} noRemember />);
    expect(screen.queryByRole("button", { name: /Always/ })).toBeNull();
    settle();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onDecide).toHaveBeenCalledWith(true);
  });
});

describe("a press on a card that has not sat still", () => {
  it("is not a decision until the card has been on screen a moment", () => {
    const { onDecide } = card();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onDecide).not.toHaveBeenCalled();
    settle();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onDecide).toHaveBeenCalledWith(true);
  });

  it("waits again when the card comes to say something else", () => {
    const { onDecide, rerender } = card();
    settle();
    rerender(<AskCard view={{ ...view, title: "Something else" }} tool="browser.act" args={args} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("waits again when the card slid under a still pointer", () => {
    const { onDecide, section } = card();
    settle();
    let top = 100;
    vi.spyOn(section, "getBoundingClientRect").mockImplementation(() => ({ top, left: 0 }) as DOMRect);
    const approve = screen.getByRole("button", { name: "Approve" });
    fireEvent.pointerMove(approve);
    // A card arrived above: this one moved down, and what is now under the pointer is not what was aimed at.
    top = 260;
    fireEvent.pointerDown(approve);
    fireEvent.click(approve);
    expect(onDecide).not.toHaveBeenCalled();
    settle();
    fireEvent.pointerMove(approve);
    fireEvent.pointerDown(approve);
    fireEvent.click(approve);
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

describe("an ask that places a secret", () => {
  it("offers no remembered yes, and says why beside the buttons", () => {
    const secret = askView({ tool: "http.fetch", args: { url: "https://api.example.com", headers: { authorization: "Bearer {{secret:k}}" } }, rule: { tool: "http.fetch", scope: "host:api.example.com" } });
    const { container } = render(<AskCard view={secret} tool="http.fetch" onDecide={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Always/ })).toBeNull();
    expect(container.querySelector(".kos-ask-actions .kos-ask-note")?.textContent).toBe("Secrets always ask");
  });

  it("draws a secret's ask with its label, handle, fields and the real origin, and no rule's always", () => {
    const secret = { handle: "github-login-9xq1", label: "GitHub", kind: "login" as const, fields: ["username" as const, "password" as const], origin: "http://login.github.com.evil.example", frameOrigins: ["https://js.stripe.com"], surface: "kos-browser" as const, warnings: ["The page is not encrypted (plain http)."], remember: [], targets: [{ field: "username", label: "Email", type: "email" }, { field: "password", label: "Password", type: "password" }], formAction: "http://login.github.com.evil.example/session" };
    const fill = { secret: secret.handle, label: "GitHub", fields: [{ field: "username", target: "@e3" }, { field: "password", target: "@e4" }], origin: secret.origin };
    const asked = askView({ tool: "secrets.fill", args: fill, rule: { tool: "secrets.fill", scope: null, project: null }, secret });
    const { container } = render(<AskCard view={asked} tool="secrets.fill" args={fill} onDecide={vi.fn()} />);
    expect(container.querySelector(".kos-ask-title")?.textContent).toBe("Fill username and password from GitHub (github-login-9xq1)");
    expect(container.querySelector(".kos-ask-secret-what")?.textContent).toBe("GitHub github-login-9xq1 · username, password");
    // The registrable domain is what says whose site it is: in bold, apart from what comes before it.
    expect(container.querySelector(".kos-ask-secret-origin strong")?.textContent).toBe("evil.example");
    expect(container.querySelector(".kos-ask-secret-origin")?.textContent).toBe("http://login.github.com.evil.example");
    expect(container.querySelector(".kos-ask-secret-frames")?.textContent).toBe("In a frame from js.stripe.com");
    expect(container.querySelector(".kos-ask-secret .tag--warn")?.textContent).toBe("The page is not encrypted (plain http).");
    expect(container.querySelectorAll(".kos-ask-secret-frames")[1]?.textContent).toBe("Into username → “Email” (email), password → “Password” (password), a form sending to http://login.github.com.evil.example/session");
    expect(screen.queryByRole("button", { name: /Always/ })).toBeNull();
    expect(container.querySelector(".kos-ask-note")?.textContent).toBe("Secrets always ask");
  });

  it("offers a site's always only where the secret's policy keeps one", () => {
    const secret = { handle: "github-login-9xq1", label: "GitHub", kind: "login" as const, fields: ["password" as const], origin: "https://github.com", frameOrigins: [], surface: "kos-browser" as const, warnings: [], remember: ["site" as const] };
    const onDecide = vi.fn();
    render(<AskCard view={askView({ tool: "secrets.fill", args: { secret: secret.handle }, secret })} tool="secrets.fill" onDecide={onDecide} />);
    settle();
    fireEvent.click(screen.getByRole("button", { name: "Approve, and always on github.com" }));
    expect(onDecide).toHaveBeenCalledWith(true, true);
  });
});
