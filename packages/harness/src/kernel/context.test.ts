import { describe, expect, it } from "vitest";

import { assembleSystemPrompt, inferScopeTags } from "./context.js";
import { DEFAULT_PROFILE } from "./profile.js";

describe("assembleSystemPrompt", () => {
  it("includes profile, projects, and memory", () => {
    const prompt = assembleSystemPrompt({
      baseSystem: "You are KOS.",
      profile: DEFAULT_PROFILE,
      projects: [
        {
          id: 1,
          name: "Budget",
          slug: "budget",
          type: "tracker",
          status: "active",
          description: "household",
          module: "budget",
          createdAt: 0,
          lastTouchedAt: 0,
        },
      ],
      recall: {
        facts: [
          {
            id: 1,
            userId: "owner",
            key: "currency",
            value: "USD",
            kind: "preference",
            source: null,
            createdAt: 0,
            updatedAt: 0,
          },
        ],
        episodes: [],
      },
    });
    expect(prompt).toMatch(/You are KOS/);
    expect(prompt).toMatch(/budget/);
    expect(prompt).toMatch(/currency: USD/);
    expect(prompt).toMatch(/systems\.migrate/);
  });
});

describe("inferScopeTags", () => {
  it("detects domain keywords", () => {
    expect(inferScopeTags("schedule a cron job")).toContain("cron");
    expect(inferScopeTags("fetch https://example.com")).toContain("http");
    expect(inferScopeTags("create a task list")).toEqual(
      expect.arrayContaining(["tasks", "systems"]),
    );
  });
});
