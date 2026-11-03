// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Markdown, MentionNames } from "./Markdown.js";

function html(text: string): string {
  const { container } = render(<Markdown text={text} />);
  return container.innerHTML;
}

describe("Markdown", () => {
  it("renders emphasis and inline code", () => {
    expect(html("**bold** and *italic* and `code`")).toContain("<strong>bold</strong>");
    expect(html("**bold** and *italic* and `code`")).toContain("<em>italic</em>");
    expect(html("**bold** and *italic* and `code`")).toContain("<code>code</code>");
  });

  it("shows a time on the reader's clock, and subtext small", () => {
    const seconds = Math.floor(Date.now() / 1000) + 3 * 3600;
    const out = html(`Due <t:${seconds}:R>.\n-# Source: the calendar`);
    expect(out).toContain('class="md-time"');
    expect(out).toContain(">in 3 hours</time>");
    expect(out).toContain('<p class="md-sub">Source: the calendar</p>');
    // A time as written is read in this browser's zone, so its clock reads back as written.
    expect(html("<t:2026-10-19T07:30:t>")).toContain(">07:30</time>");
    expect(html("<t:2026-10-19T07:30:D>")).toContain(">19 October 2026</time>");
    // One that does not parse stays as typed, and code is never a token.
    expect(html("at <t:never:R>")).toContain("at &lt;t:never:R&gt;");
    expect(html("`<t:1:t>`")).toContain("<code>&lt;t:1:t&gt;</code>");
    // Two small lines are one block; a paragraph ends where subtext starts.
    expect(html("Main line\n-# one\n-# two")).toBe('<div class="md"><p class="md-p">Main line</p><p class="md-sub">one<br>two</p></div>');
  });

  it("typesets math and leaves prices and code alone", async () => {
    const { container } = render(<Markdown text={"So $x^2$ costs $5 and $10, not `$y$`.\n\n$$\n\\frac{a}{b}\n$$"} />);
    const inline = container.querySelector(".md-p .md-math");
    const block = container.querySelector(".md-math-block .md-math--display");
    // The source stands in until KaTeX has loaded, then it is typeset.
    expect(inline?.textContent).toContain("x^2");
    await waitFor(() => expect(container.querySelectorAll(".katex")).toHaveLength(2));
    expect(block?.querySelector(".katex-display")).not.toBeNull();
    expect(container.querySelector(".md-p")?.textContent).toContain("costs $5 and $10");
    expect(container.querySelector("code")?.textContent).toBe("$y$");
  });

  it("never lets a formula carry markup or a link", async () => {
    const { container } = render(<Markdown text={"$\\href{javascript:alert(1)}{x} <img src=x onerror=alert(1)>$"} />);
    await waitFor(() => expect(container.querySelector(".katex, .katex-error")).not.toBeNull());
    expect(container.querySelector("a, img")).toBeNull();
  });

  it("nests a list under the item it belongs to, and keeps the count", () => {
    const out = html("1. Install\n   - brew install x\n   - or the app\n2. Run\n   1. once\n- loose");
    expect(out).toContain(
      '<ol class="md-list"><li><p class="md-p">Install</p><ul class="md-list"><li><p class="md-p">brew install x</p></li><li><p class="md-p">or the app</p></li></ul></li><li><p class="md-p">Run</p><ol class="md-list"><li><p class="md-p">once</p></li></ol></li></ol>',
    );
    // A bullet at the top after a numbered list is a list of its own.
    expect(out).toContain('<ul class="md-list"><li><p class="md-p">loose</p></li></ul>');
  });

  it("draws code and math inside a list item, and the words after a sub-list after it", () => {
    const { container } = render(<Markdown text={"1. Run:\n   ```bash\n   npm i\n   ```\n2. Then\n   - a\n   more of then\n\nAfter"} />);
    const items = container.querySelectorAll(".md > ol > li");
    expect(items).toHaveLength(2);
    expect(items[0]?.querySelector("pre.md-code code")?.textContent).toBe("npm i");
    expect([...(items[1]?.children ?? [])].map((c) => c.tagName)).toEqual(["P", "UL", "P"]);
    expect(container.querySelector(".md > p")?.textContent).toBe("After");
  });

  it("keeps markdown inside backticks literal", () => {
    // The whole point of code spans: `**x**` is two asterisks, not bold.
    const out = html("use `**not bold**` here");
    expect(out).toContain("<code>**not bold**</code>");
    expect(out).not.toContain("<strong>");
  });

  it("keeps a code span inside bold, and the bold around it", () => {
    // Code had precedence, so a code span in the middle of a bold run matched
    // first and split the bold around it, leaving the asterisks on the page.
    const out = html("**5. Files under `projects/x/` **");
    expect(out).toContain("<strong>");
    expect(out).toContain("<code>projects/x/</code>");
    expect(out).not.toContain("**");
  });

  it("renders fenced code blocks with their language", () => {
    const out = html("```sql\nSELECT 1\n```");
    expect(out).toContain("SELECT 1");
    expect(out).toContain('data-lang="sql"');
  });

  it("renders bullet and numbered lists", () => {
    expect(html("- one\n- two")).toContain("<ul");
    expect(html("1. one\n2. two")).toContain("<ol");
    render(<Markdown text={"- alpha\n- beta"} />);
    expect(screen.getByText("alpha")).toBeTruthy();
  });

  it("renders headings and quotes", () => {
    expect(html("## Spending")).toContain("Spending");
    expect(html("> a quote")).toContain("<blockquote");
  });

  it("linkifies markdown links and bare urls, safely", () => {
    const masked = html("[docs](https://example.com/x)");
    expect(masked).toContain('href="https://example.com/x"');
    expect(masked).toContain('rel="noopener noreferrer"');
    expect(html("see https://example.com now")).toContain("<a ");
  });

  it("cannot inject markup", () => {
    // React elements, never innerHTML: a script tag is text, not a node.
    const out = html('<script>alert(1)</script> and <b>raw</b>');
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
    expect(out).not.toContain("<b>raw</b>");
  });

  it("keeps an unterminated fence as a code block rather than losing it", () => {
    expect(html("```\nstranded")).toContain("stranded");
  });

  it("preserves single newlines inside a paragraph", () => {
    expect(html("one\ntwo")).toContain("<br>");
  });

  it("leaves plain text alone", () => {
    expect(html("just words")).toContain("just words");
  });
});

describe("Markdown lists", () => {
  it("keeps one ordered list when items are separated by blank lines", () => {
    // A model writing a spaced-out list produced a fresh <ol> per item, so the
    // reader saw "1." three times instead of 1, 2, 3.
    const { container } = render(
      <Markdown text={"1. first\n\n2. second\n\n3. third"} />,
    );
    expect(container.querySelectorAll("ol")).toHaveLength(1);
    expect(container.querySelectorAll("li")).toHaveLength(3);
  });

  it("ends the list when the blank line is followed by prose", () => {
    const { container } = render(
      <Markdown text={"1. first\n2. second\n\nAnd that is all."} />,
    );
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector(".md > p")?.textContent).toBe("And that is all.");
  });

  it("starts an ordered list at the number it was written with", () => {
    const { container } = render(<Markdown text={"3. third\n4. fourth"} />);
    expect(container.querySelector("ol")?.getAttribute("start")).toBe("3");
  });
});

describe("Markdown tables", () => {
  const table = [
    "| Cause | Likelihood | Note |",
    "| --- | ---: | :---: |",
    "| Month filter | High | stat filters to this month |",
    "| Stale cache | Low | possible |",
  ].join("\n");

  it("renders a pipe table as a table", () => {
    // An agent's comparison table arrived as a screenful of raw pipes, which
    // is the shape of answer a table is chosen for in the first place.
    const { container } = render(<Markdown text={table} />);
    expect(container.querySelectorAll("th")).toHaveLength(3);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(container.textContent).not.toContain("---");
  });

  it("honours column alignment", () => {
    const { container } = render(<Markdown text={table} />);
    const heads = [...container.querySelectorAll("th")];
    expect(heads[1]?.style.textAlign).toBe("right");
    expect(heads[2]?.style.textAlign).toBe("center");
  });

  it("renders inline markup inside cells", () => {
    const { container } = render(
      <Markdown text={"| a |\n| --- |\n| `code` |"} />,
    );
    expect(container.querySelector("td code")?.textContent).toBe("code");
  });

  it("leaves a lone pipe line as text", () => {
    const { container } = render(<Markdown text={"| not a table"} />);
    expect(container.querySelector("table")).toBeNull();
    expect(container.textContent).toContain("| not a table");
  });
});

describe("references in a message", () => {
  it("renders a mention as a chip showing what was named", () => {
    const { container } = render(<Markdown text="look at @file:notes/todo.md now" />);
    const chip = container.querySelector(".chip-ref--file");
    expect(chip?.textContent).toBe("notes/todo.md");
    expect(container.textContent).not.toContain("@file:");
  });

  it("colours a chip by what kind of thing it is", () => {
    const { container } = render(
      <Markdown text="@project:budget and @schedule:nightly" />,
    );
    expect(container.querySelector(".chip-ref--project")?.textContent).toBe("budget");
    expect(container.querySelector(".chip-ref--schedule")?.textContent).toBe("nightly");
  });

  it("renders a known slash command as a chip", () => {
    const { container } = render(<Markdown text="/archive" />);
    expect(container.querySelector(".chip-ref--command")?.textContent).toBe("/archive");
  });

  it("does not swallow the sentence's full stop", () => {
    const { container } = render(<Markdown text="check @schedule:kos.backup." />);
    expect(container.querySelector(".chip-ref--schedule")?.textContent).toBe(
      "kos.backup",
    );
    expect(container.textContent).toContain("kos.backup.");
  });

  it("leaves an ordinary slash alone", () => {
    // A path is not a command.
    const { container } = render(<Markdown text="see docs/api for more" />);
    expect(container.querySelector(".chip-ref")).toBeNull();
    expect(container.textContent).toContain("docs/api");
  });

  it("leaves an email address alone", () => {
    const { container } = render(<Markdown text="mail me@example.com" />);
    expect(container.querySelector(".chip-ref")).toBeNull();
  });
});

/**
 * Every kind the picker offers should render as a chip. Only four of the
 * seven did, so a message naming a chat, a site or an agent showed the raw
 * reference in the middle of a sentence.
 */
describe("every kind of reference", () => {
  const kinds = [
    ["project", "budget_tracker"],
    ["page", "budget-dashboard"],
    ["file", "notes/today.md"],
    ["schedule", "[9 AM Pinger Test]"],
    ["chat", "[abc123:owner]"],
    ["site", "budget_tracker/expenses"],
    ["agent", "7"],
    ["tab", "A1B2C3"],
  ] as const;

  for (const [kind, id] of kinds) {
    it(`chips a ${kind}`, () => {
      const { container } = render(<Markdown text={`See @${kind}:${id} here.`} />);
      const chip = container.querySelector(`.chip-ref--${kind}`);
      expect(chip).toBeTruthy();
      // The reference must not also survive as literal text beside the chip.
      expect(container.textContent).not.toContain(`@${kind}:`);
    });
  }

  it("uses the name the surface knows over the id", () => {
    const { container } = render(
      <MentionNames resolve={(k, id) => (k === "chat" ? `Lane A (${id})` : undefined)}>
        <Markdown text="see @chat:[abc123:owner]" />
      </MentionNames>,
    );
    expect(container.querySelector(".chip-ref--chat")?.textContent).toBe(
      "Lane A (abc123:owner)",
    );
  });

  it("draws a channel the view knows as a chip that opens on Discord, and leaves a # it does not", () => {
    const { container } = render(
      <MentionNames
        resolve={(k, id) => (k === "channel" && id === "leetcode" ? "#leetcode" : undefined)}
        hrefOf={(k, id) => (k === "channel" ? `https://discord.com/channels/g1/${id}` : undefined)}
      >
        <Markdown text="posted in #leetcode, fix #3 and `#leetcode`" />
      </MentionNames>,
    );
    const chip = container.querySelector<HTMLAnchorElement>("a.chip-ref--channel");
    expect(chip?.textContent).toBe("#leetcode");
    expect(chip?.getAttribute("href")).toBe("https://discord.com/channels/g1/leetcode");
    expect(chip?.getAttribute("target")).toBe("_blank");
    expect(container.querySelectorAll(".chip-ref--channel")).toHaveLength(1);
    expect(container.textContent).toContain("fix #3");
    expect(container.querySelector("code")?.textContent).toBe("#leetcode");
    // With no view to say, a # stays words.
    expect(html("in #leetcode")).not.toContain("chip-ref");
  });

  it("falls back to the id when nothing knows better", () => {
    const { container } = render(<Markdown text="see @chat:[abc123:owner]" />);
    expect(container.querySelector(".chip-ref--chat")?.textContent).toBe(
      "abc123:owner",
    );
  });
});

/** What KOS for Chrome's side panel drew with its own renderer, now drawn with this one. */
describe("the side panel's cases", () => {
  it("reads the blocks a chat uses, and leaves a grid with no head line as the text it was", () => {
    const { container } = render(
      <Markdown text={"# Mug\n\nIt is **$16**.\nShips soon.\n\n- one\n- two\n\n1. first\n\n> quoted\n\n-# as of today\n\n```\ncode\n```\n| a | b |\n| 1 | 2 |"} />,
    );
    expect(container.querySelector("h3.md-h")?.textContent).toBe("Mug");
    expect(container.querySelector(".md-p strong")?.textContent).toBe("$16");
    expect(container.querySelector(".md-p br")).not.toBeNull();
    expect(container.querySelectorAll("ul.md-list > li")).toHaveLength(2);
    expect(container.querySelectorAll("ol.md-list > li")).toHaveLength(1);
    expect(container.querySelector("blockquote")?.textContent).toBe("quoted");
    expect(container.querySelector(".md-sub")?.textContent).toBe("as of today");
    expect(container.querySelector("pre.md-code code")?.textContent).toBe("code");
    expect(container.querySelector("table")).toBeNull();
    expect(container.textContent).toContain("| a | b || 1 | 2 |");
  });

  it("reads a table with its head line as a table, each column aligned, a \\| kept in its cell", () => {
    const { container } = render(<Markdown text={"| Form | Value | Note |\n| --- | ---: | :-: |\n| Decimal | 18446744073709551616 | a \\| b |\n| Hex | 0x1 |"} />);
    expect([...container.querySelectorAll("th")].map((th) => [th.textContent, th.style.textAlign])).toEqual([
      ["Form", "left"],
      ["Value", "right"],
      ["Note", "center"],
    ]);
    expect([...container.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent))).toEqual([
      ["Decimal", "18446744073709551616", "a | b"],
      ["Hex", "0x1", ""],
    ]);
  });

  it("links only to the web and mail, ends a bare address before the sentence's stop, and names KOS's references", () => {
    const { container } = render(
      <Markdown text="see [docs](https://kos.example/a), [mail](mailto:kos@example.com) and [bad](javascript:alert(1)), or https://kos.example/b. Then @approval:6 and @page:[Budget]" />,
    );
    expect([...container.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["https://kos.example/a", "mailto:kos@example.com", "https://kos.example/b"]);
    expect(container.textContent).toContain("[bad](javascript:alert(1))");
    expect(container.textContent).toContain("https://kos.example/b. Then");
    // With no routes of the surface's own, a reference is a chip that goes nowhere.
    expect([...container.querySelectorAll("span.chip-ref")].map((c) => c.textContent)).toEqual(["#6", "Budget"]);
  });

  it("reads math as formulas and prices as prices", () => {
    const { container } = render(<Markdown text={"Area:\n$$\n\\pi r^2\n$$\nso $a_1 + b$ costs $5 and \\(x\\) is `$y$`"} />);
    expect(container.querySelector(".md-math-block .md-math--display")?.textContent).toContain("\\pi r^2");
    expect([...container.querySelectorAll(".md-p .md-math")].map((m) => m.textContent)).toEqual(["a_1 + b", "x"]);
    expect(container.textContent).toContain(" costs $5 and ");
    expect(container.querySelector("code")?.textContent).toBe("$y$");
  });

  it("reads a list item as blocks, so a list or code can sit in it, and the same lines unindented as blocks of their own", () => {
    const nested = render(<Markdown text={"1. Install\n   - brew\n   ```\n   brew install x\n   ```\n2. Run"} />).container;
    expect(nested.querySelectorAll(".md > ol > li")).toHaveLength(2);
    expect(nested.querySelector(".md > ol > li ul li")?.textContent).toBe("brew");
    expect(nested.querySelector(".md > ol > li pre code")?.textContent).toBe("brew install x");
    const flat = render(<Markdown text={"Install\n- brew\n```\nbrew install x\n```"} />).container;
    expect([...flat.querySelector(".md")!.children].map((c) => c.tagName)).toEqual(["P", "UL", "PRE"]);
  });
});
