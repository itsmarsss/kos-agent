// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { CronEditor } from "./CronEditor.js";

afterEach(cleanup);

/**
 * A job belongs to a project the way an agent does. The editor says whose
 * it is, starts a new one in the project it was written from, and keeps
 * KOS's own jobs out of the question.
 */
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
