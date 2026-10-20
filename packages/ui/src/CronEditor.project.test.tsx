// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { CronEditor, spendWords } from "./CronEditor.js";

afterEach(cleanup);

/**
 * A job belongs to a project the way an agent does. The editor says whose
 * it is, starts a new one in the project it was written from, and keeps
 * KOS's own jobs out of the question.
 */
/** The cost line: a job that thinks beside a job that runs a script. */
describe("what a job's runs cost", () => {
  it("says tokens, money and the per-run figure when the model is priced, and the last run on its own", () => {
    expect(spendWords({ runs: 7, calls: 9, inputTokens: 84_200, outputTokens: 6_100, cost: 0.35, last: { calls: 1, inputTokens: 12_000, outputTokens: 900, cost: 0.04 } })).toBe(
      "7 runs: 84.2k in, 6.1k out, $0.35, about $0.05 a run. Last run: 12.0k in, 900 out, $0.04.",
    );
  });

  it("says a script job made no model turn, which is the saving", () => {
    expect(spendWords({ runs: 3, calls: 0, inputTokens: 0, outputTokens: 0 })).toBe("3 runs, no model turn: they cost no tokens.");
  });

  it("shows tokens and asks for a rate when the model is unpriced", () => {
    expect(spendWords({ runs: 1, calls: 2, inputTokens: 5000, outputTokens: 400 })).toBe("1 run: 5.0k in, 400 out. Set the model's rate under Settings for a figure.");
  });

  it("is on the drawer of a job that has run", () => {
    render(
      <CronEditor
        job={{ id: 3, name: "Board", schedule: "0 9 * * *", type: "actions", enabled: true, spend: { runs: 2, calls: 0, inputTokens: 0, outputTokens: 0 } }}
        onDone={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText("2 runs, no model turn: they cost no tokens.")).toBeTruthy();
  });
});

describe("a schedule's project", () => {
  const projects = [
    { slug: "garden", name: "Garden" },
    { slug: "books", name: "Books" },
  ];

  it("offers the projects, none first, and starts in the one it was written from", () => {
    render(<CronEditor projects={projects} defaultProject="books" onDone={() => {}} onCancel={() => {}} />);
    expect(screen.getByText("Project")).toBeTruthy();
    // The select shows the current choice by its name.
    expect(screen.getByText("Books")).toBeTruthy();
  });

  it("shows a job's own project when editing it", () => {
    render(
      <CronEditor
        projects={projects}
        job={{ id: 3, name: "Water", schedule: "0 7 * * *", type: "actions", enabled: true, projectSlug: "garden" }}
        onDone={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText("Garden")).toBeTruthy();
  });

  it("asks nothing of KOS's own jobs", () => {
    render(
      <CronEditor
        projects={projects}
        job={{ id: 1, name: "kos.backup", schedule: "0 3 * * *", type: "actions", enabled: true }}
        onDone={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.queryByText("Project")).toBeNull();
  });
});
