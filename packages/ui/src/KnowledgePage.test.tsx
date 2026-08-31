// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { FactRow } from "./api.js";
import { KnowledgePage } from "./KnowledgePage.js";

const fact = (over: Partial<FactRow> = {}): FactRow => ({
  key: "monthly_budget",
  value: "1200 a month",
  kind: "fact",
  source: "dashboard",
  tags: ["budget", "finance"],
  pinned: false,
  updatedAt: 1,
  ...over,
});

describe("KnowledgePage", () => {
  afterEach(cleanup);

  it("lists an entry once however many tags it carries", () => {
    // Grouping put the entry under every one of its tags, so one saved fact
    // read as two, each apparently a separate thing the agent believed.
    render(
      <KnowledgePage
        facts={[fact()]}
        tags={["budget", "finance"]}
        onChanged={() => undefined}
      />,
    );
    expect(screen.getAllByText("monthly_budget")).toHaveLength(1);
  });

  it("still shows every tag on the entry itself", () => {
    render(
      <KnowledgePage
        facts={[fact()]}
        tags={["budget", "finance"]}
        onChanged={() => undefined}
      />,
    );
    expect(document.body.textContent).toContain("budget, finance");
  });
});
