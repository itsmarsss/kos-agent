import { isValidElement, type ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { blocksOf, inline } from "./markdown.js";

/** KOS's words as the side panel draws them: what it reads, and what it will not make into a link. */

describe("the side panel's markdown", () => {
  it("reads the blocks a chat uses", () => {
    expect(blocksOf("# Mug\n\nIt is **$16**.\nShips soon.\n\n- one\n- two\n\n1. first\n\n> quoted\n\n-# as of today\n\n```\ncode\n```\n| a | b |\n| 1 | 2 |")).toEqual([
      { kind: "h", level: 1, text: "Mug" },
      { kind: "p", text: "It is **$16**.\nShips soon." },
      { kind: "list", ordered: false, items: ["one", "two"] },
      { kind: "list", ordered: true, items: ["first"] },
      { kind: "quote", text: "quoted" },
      { kind: "small", text: "as of today" },
      { kind: "code", text: "code" },
      { kind: "code", text: "| a | b |\n| 1 | 2 |" },
    ]);
  });

  it("links only to the web and mail, and names KOS's references", () => {
    const parts = inline("see [docs](https://kos.example/a) and [bad](javascript:alert(1)) or @approval:6 and @page:[Budget]");
    const elements = parts.filter(isValidElement) as ReactElement<{ href?: string; children?: unknown; className?: string }>[];
    expect(elements.filter((e) => e.type === "a").map((e) => e.props.href)).toEqual(["https://kos.example/a"]);
    expect(parts.join("")).toContain("[bad](javascript:alert(1))");
    expect(elements.filter((e) => e.props.className === "mention").map((e) => e.props.children)).toEqual(["approval 6", "Budget"]);
  });
});
