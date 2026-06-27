// @vitest-environment jsdom
import type { PageSpec } from "@kos/shared";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PageRenderer } from "./PageRenderer.js";

describe("PageRenderer", () => {
  afterEach(cleanup);

  it("renders widgets from a valid spec", () => {
    const spec: PageSpec = {
      id: "budget",
      title: "Budget Tracker",
      widgets: [
        { type: "stat", label: "Spent", query: "SELECT 1" },
        { type: "table", query: "SELECT * FROM tx" },
      ],
    };
    render(
      <PageRenderer
        spec={spec}
        data={{ 0: [{ total: 42 }], 1: [{ a: 1, b: 2 }] }}
      />,
    );
    expect(screen.getByText("Budget Tracker")).toBeTruthy();
    expect(screen.getByText("Spent")).toBeTruthy();
    expect(screen.getByText("42")).toBeTruthy();
  });

  it("flags an invalid spec instead of rendering it", () => {
    const bad = {
      id: "1 Bad",
      title: "x",
      widgets: [],
    } as unknown as PageSpec;
    render(<PageRenderer spec={bad} />);
    expect(screen.getByText(/Invalid page/)).toBeTruthy();
  });

  it("renders a safe placeholder for an unknown widget type", () => {
    const spec = {
      id: "p",
      title: "P",
      widgets: [{ type: "spreadsheet", query: "SELECT 1" }],
    } as unknown as PageSpec;
    // validator rejects unknown type -> shown as invalid page, not a crash
    render(<PageRenderer spec={spec} />);
    expect(screen.getByText(/Invalid page/)).toBeTruthy();
  });
});
