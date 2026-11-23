import { describe, expect, it } from "vitest";

import type { AgentInfo } from "./api.js";
import { upTo } from "./AgentsPage.js";

const blob = (over: Partial<AgentInfo>): AgentInfo =>
  ({ name: "recap", description: "", brief: "", path: "blobs/recap/blob.md", folder: "blobs/recap", updatedAt: 0, conversationId: "agent:recap", thread: { id: "agent:recap", activity: "idle", unread: false, updatedAt: Date.now(), lastSaid: "Done. The notes folder holds two files." }, ...over }) as AgentInfo;
const job = { id: 1, schedule: "0 17 * * 5", enabled: true, lastRunAt: 1, nextRunAt: null };

describe("a blob's card line", () => {
  it("says its last run failed rather than quote a reply over failed steps", () => {
    expect(upTo(blob({ job: { ...job, lastOutcome: { status: "error", error: "Its one step failed. files.read: ENOENT: no such file or directory, open '/w/notes/todo.md'" } } }))).toBe("Its last run failed: There is no file or folder called “todo.md”.");
  });

  it("marks a reply from a run that finished with errors, and quotes a clean one", () => {
    expect(upTo(blob({ job: { ...job, lastOutcome: { status: "partial", error: "1 of 2 steps failed." } } }))).toMatch(/^With errors: “Done\. The notes folder holds two files\.” · /);
    expect(upTo(blob({ job: { ...job, lastOutcome: { status: "ok", error: null } } }))).toMatch(/^“Done\./);
  });
});
