// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown, MentionNames } from "@kos/kit";
import type { ReactElement } from "react";

import { OpenTab } from "./opentab.js";
import { DashboardRefs } from "./refs.js";

/** KOS's words as the dashboard draws them: each reference a link to its page. */
const md = (text: string): ReactElement => (
  <DashboardRefs>
    <Markdown text={text} />
  </DashboardRefs>
);

describe("references are links", () => {
  it("links a page to its page route", () => {
    const { container } = render(md("see @page:budget-dash"));
    const a = container.querySelector("a.chip-ref--page");
    expect(a?.getAttribute("href")).toBe("#/page/budget-dash");
  });

  it("links a file to the browser at that path", () => {
    const { container } = render(md("see @file:notes/todo.md"));
    expect(container.querySelector("a.chip-ref--file")?.getAttribute("href")).toBe("#/files/notes%2Ftodo.md");
  });

  it("keeps the colons an id may carry: a chat's owner, a blob's job", () => {
    const { container } = render(md("fired by @schedule:blob:briefing at 07:30, see @chat:cmv1:owner."));
    const chips = [...container.querySelectorAll("a.chip-ref")].map((a) => [a.textContent, a.getAttribute("href")]);
    expect(chips).toEqual([
      ["blob:briefing", "#/schedule/blob%3Abriefing"],
      ["cmv1:owner", "#/chats/cmv1%3Aowner"],
    ]);
    expect(container.textContent).toBe("fired by blob:briefing at 07:30, see cmv1:owner.");
  });

  it("links a schedule to its own drawer on the schedule page", () => {
    const { container } = render(md("@schedule:nightly and @schedule:[Email Amy Reminder]"));
    const hrefs = [...container.querySelectorAll("a.chip-ref--schedule")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["#/schedule/nightly", "#/schedule/Email%20Amy%20Reminder"]);
  });

  it("links every kind the picker offers", () => {
    for (const [kind, id] of [
      ["project", "budget_tracker"],
      ["page", "budget-dashboard"],
      ["file", "notes/today.md"],
      ["schedule", "[9 AM Pinger Test]"],
      ["chat", "[abc123:owner]"],
      ["site", "budget_tracker/expenses"],
      ["agent", "7"],
      ["tab", "A1B2C3"],
    ] as const) {
      const { container } = render(md(`See @${kind}:${id} here.`));
      expect(container.querySelector(`a.chip-ref--${kind}`)?.getAttribute("href"), kind).toBeTruthy();
    }
  });

  it("draws an approval as a chip that opens it in the inbox, numbered", () => {
    const { container } = render(md("Waiting on you: discord.audience needs approval (@approval:290)."));
    const chip = container.querySelector<HTMLAnchorElement>("a.chip-ref--approval");
    expect(chip?.textContent).toBe("#290");
    expect(chip?.getAttribute("href")).toBe("#/inbox/290");
  });

  it("opens the browser on a tab chip rather than going anywhere", () => {
    const opened: string[] = [];
    const { container } = render(
      <OpenTab.Provider value={(tab) => opened.push(tab)}>
        <MentionNames resolve={(k, id) => (k === "tab" ? `Hacker News (${id})` : undefined)}>{md("look at @tab:A1B2C3")}</MentionNames>
      </OpenTab.Provider>,
    );
    const chip = container.querySelector(".chip-ref--tab") as HTMLAnchorElement;
    expect(chip.textContent).toBe("Hacker News (A1B2C3)");
    fireEvent.click(chip);
    expect(opened).toEqual(["A1B2C3"]);
  });
});
