// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Markdown } from "./Markdown.js";
import { formatElapsed } from "./LiveTurn.js";

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

  it("keeps markdown inside backticks literal", () => {
    // The whole point of code spans: `**x**` is two asterisks, not bold.
    const out = html("use `**not bold**` here");
    expect(out).toContain("<code>**not bold**</code>");
    expect(out).not.toContain("<strong>");
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
    expect(container.querySelector("p")?.textContent).toBe("And that is all.");
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

describe("elapsed formatting", () => {
  it("rolls seconds into minutes and hours", () => {
    // It counted up in seconds forever, so a long turn read as "312s".
    expect(formatElapsed(45_000)).toBe("45s");
    expect(formatElapsed(200_000)).toBe("3m 20s");
    expect(formatElapsed(3_840_000)).toBe("1h 4m");
  });
});
