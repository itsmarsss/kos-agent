// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BlockActions } from "./KosBlock.js";
import { Markdown } from "./Markdown.js";

const EMAIL = "Here it is.\n\n```kos:email\nto: sam@example.com\nto: amy@example.com\nsubject: Saturday at 4\n---\nHi Sam,\n\nStill on?\n```\n\nSay if it needs work.";

afterEach(cleanup);

describe("a typed block in KOS's words", () => {
  it("draws an email as its head, its fields and its body, between the prose", () => {
    const { container } = render(<Markdown text={EMAIL} />);
    const block = screen.getByRole("region", { name: "Email" });
    expect(within(block).getByText("To").tagName).toBe("DT");
    expect(within(block).getByText("sam@example.com")).toBeTruthy();
    expect(within(block).getByText("amy@example.com")).toBeTruthy();
    expect(within(block).getByText("Saturday at 4")).toBeTruthy();
    // The body as written, blank line and all, never read as markdown.
    expect(block.querySelector(".kblock-text")?.textContent).toBe("Hi Sam,\n\nStill on?");
    expect(container.querySelectorAll("p.md-p")).toHaveLength(2);
    expect(container.querySelector("pre")).toBeNull();
  });

  it("opens the draft in the mail app and copies its body", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<Markdown text={EMAIL} />);
    const mail = screen.getByRole("link", { name: "Open in Mail" });
    expect(mail.getAttribute("href")).toBe("mailto:sam%40example.com,amy%40example.com?subject=Saturday%20at%204&body=Hi%20Sam%2C%0A%0AStill%20on%3F");
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith("Hi Sam,\n\nStill on?");
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy());
  });

  it("offers Send only with a tool for it, and asks KOS once, the draft quoted", () => {
    render(<Markdown text={EMAIL} />);
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    cleanup();
    const ask = vi.fn();
    render(
      <BlockActions.Provider value={{ tools: ["notify"], ask }}>
        <Markdown text={EMAIL} />
      </BlockActions.Provider>,
    );
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    cleanup();
    render(
      <BlockActions.Provider value={{ tools: ["mcp.gmail.send_email"], ask }}>
        <Markdown text={EMAIL} />
      </BlockActions.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0]?.[0]).toMatch(/^Send this email as drafted, with mcp\.gmail\.send_email\.\n\n```kos:email\nto: sam@example.com\n/);
    const asked = screen.getByRole("button", { name: "Asked KOS to send it" });
    expect((asked as HTMLButtonElement).disabled).toBe(true);
  });

  it("saves an event as an .ics", () => {
    const createObjectURL = vi.fn(() => "blob:event");
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    render(<Markdown text={"```kos:event\ntitle: Dinner at Nopa\nwhen: 2026-11-21 19:30\nwhere: Nopa\n```"} />);
    const block = screen.getByRole("region", { name: "Event" });
    expect(within(block).getByText("Dinner at Nopa").className).toBe("kblock-title");
    fireEvent.click(screen.getByRole("button", { name: "Add to calendar" }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe("dinner-at-nopa.ics");
    click.mockRestore();
  });

  it("ticks a checklist here only", () => {
    render(<Markdown text={"```kos:checklist\ntitle: Groceries\n---\n- [ ] milk\n- [x] eggs\nfrom the corner shop\n```"} />);
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([false, true]);
    fireEvent.click(boxes[0] as HTMLInputElement);
    expect(boxes[0]?.checked).toBe(true);
    expect(screen.getByText("from the corner shop").className).toBe("kblock-check-note");
  });

  it("draws steps, a command, a quote and a diff by their bodies", () => {
    const { container } = render(
      <Markdown
        text={[
          "```kos:steps\ntitle: Reset\n---\n1. Unplug it\n2. Wait\n```",
          "```kos:command\ncwd: ~/kos\n---\npnpm test\n```",
          "```kos:quote\nsource: Seneca\n---\nWe suffer more in imagination.\n```",
          "```kos:diff\nfile: a.ts\n---\n@@ -1 +1 @@\n-old\n+new\n```",
        ].join("\n\n")}
      />,
    );
    expect([...container.querySelectorAll(".kblock-steps li")].map((li) => li.textContent)).toEqual(["Unplug it", "Wait"]);
    expect(container.querySelector(".kblock--mono .kblock-code")?.textContent).toBe("pnpm test");
    expect(container.querySelector(".kblock-quote")?.textContent).toBe("We suffer more in imagination.");
    expect([...container.querySelectorAll(".kblock-diff code > span")].map((s) => s.className)).toEqual(["kblock-diff-hunk", "kblock-diff-del", "kblock-diff-add"]);
  });

  it("draws an unknown kind as a card, and a card under its title, with only safe links", () => {
    const { container } = render(
      <Markdown text={"```kos:recipe\ntitle: Soup\nserves: 4\n---\nBoil.\n```\n\n```kos:card\ntitle: Plan\naction: open https://example.com Read more\naction: delete everything\n---\n- **go** early\n```"} />,
    );
    expect(screen.getByRole("region", { name: "Recipe" }).querySelector(".kblock-title")?.textContent).toBe("Soup");
    expect(screen.getByText("Serves").tagName).toBe("DT");
    const card = screen.getByRole("region", { name: "Plan" });
    // A card's body is markdown.
    expect(card.querySelector(".kblock-md strong")?.textContent).toBe("go");
    expect(within(card).getByRole("link", { name: "Read more" }).getAttribute("href")).toBe("https://example.com");
    expect(container.textContent).not.toContain("delete everything");
  });

  it("keeps a malformed block as the code block it was, and a fence inside a longer one", () => {
    const { container } = render(<Markdown text={"```kos:email\nHi Sam,\nsee you\n```\n\n````kos:card\ntitle: Snippet\n---\n```ts\nconst a = 1;\n```\n````\n\nafter"} />);
    expect(container.querySelector("pre.md-code")?.getAttribute("data-lang")).toBe("kos:email");
    expect(container.querySelector("pre.md-code")?.textContent).toBe("Hi Sam,\nsee you");
    const card = screen.getByRole("region", { name: "Snippet" });
    expect(card.querySelector("pre.md-code")?.textContent).toBe("const a = 1;");
    expect(container.querySelector(".md-p:last-child")?.textContent).toBe("after");
  });

  it("draws a block still arriving, and a line of backticks with words after it as words", () => {
    render(<Markdown text={"```kos:message\nto: Sam\nchannel: imessage\n---\nRunning la"} />);
    expect(screen.getByRole("region", { name: "Message" }).querySelector(".kblock-text")?.textContent).toBe("Running la");
    cleanup();
    const { container } = render(<Markdown text={"```js title\nx"} />);
    expect(container.querySelector(".md-p")?.textContent).toBe("```js titlex");
  });
});
