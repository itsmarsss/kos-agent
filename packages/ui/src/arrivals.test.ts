import { describe, expect, it } from "vitest";

import type { PendingAction } from "./api.js";
import { arrivalWords } from "./arrivals.js";

const ask = (id: number, title: string, asker?: string): PendingAction => ({ id, tool: "http.fetch", args: "{}", reason: null, conversationId: "c1", requestedAt: 0, title, ...(asker ? { asker } : {}) }) as PendingAction;

describe("an ask arriving, said", () => {
  it("names who asks and what", () => {
    expect(arrivalWords([ask(1, "Fetch the status page", "Garden")])).toBe("New approval. Garden asks: Fetch the status page");
  });
  it("says nothing when none arrived, and a count past a few", () => {
    expect(arrivalWords([])).toBeNull();
    expect(arrivalWords([1, 2, 3, 4].map((i) => ask(i, "x")))).toBe("4 new approvals in the Inbox");
  });
});
