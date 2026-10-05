import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { SuggestionStore } from "./store.js";

describe("the suggestion store", () => {
  let db: Database.Database;
  let store: SuggestionStore;
  let clock: number;

  beforeEach(() => {
    db = new Database(":memory:");
    clock = 1000;
    store = new SuggestionStore(db, () => clock);
  });
  afterEach(() => db.close());

  it("raises a suggestion and lists it while it is open", () => {
    const s = store.add("blueprint", "Make the pantry a module", "You have built three pantry-shaped projects.", "Promote the pantry project.");
    expect(s).toMatchObject({ kind: "blueprint", title: "Make the pantry a module", action: "Promote the pantry project.", resolvedAt: null });
    expect(store.pending().map((x) => x.id)).toEqual([s.id]);
  });

  it("does not raise the same kind and title twice while one is open", () => {
    const a = store.add("skill", "A skill for the weekly digest", "seen it done by hand four times");
    const b = store.add("skill", "a skill for the weekly digest", "again");
    expect(b.id).toBe(a.id);
    expect(store.pending()).toHaveLength(1);
  });

  it("raises it again once the first is resolved", () => {
    const a = store.add("skill", "X", "d");
    store.resolve(a.id, "dismissed");
    const b = store.add("skill", "X", "d");
    expect(b.id).not.toBe(a.id);
    expect(store.pending().map((x) => x.id)).toEqual([b.id]);
  });

  it("resolves out of pending but keeps it in recent with the outcome", () => {
    const a = store.add("other", "X", "d");
    store.resolve(a.id, "accepted; working in c1");
    expect(store.pending()).toEqual([]);
    expect(store.recent()[0]).toMatchObject({ id: a.id, resolution: "accepted; working in c1", resolvedAt: clock });
  });

  it("falls back to other for an unknown kind and refuses an empty title", () => {
    expect(store.add("nonsense" as never, "T", "d").kind).toBe("other");
    expect(() => store.add("skill", "   ", "d")).toThrow(/title/);
  });
});
