// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { applySuggestion, readTrigger, splitQuery } from "./Autocomplete.js";

const pick = { insert: "@file:notes.md", label: "notes.md", kind: "file" };

describe("readTrigger", () => {
  it("sees a mention being typed at the caret", () => {
    expect(readTrigger("look at @not", 12)).toEqual({
      char: "@",
      query: "not",
      at: 8,
    });
  });

  it("sees a bare trigger with nothing typed yet", () => {
    expect(readTrigger("look at @", 9)).toMatchObject({ char: "@", query: "" });
  });

  it("ignores an @ inside a word", () => {
    // An email address is not a mention.
    expect(readTrigger("mail me@example.com", 19)).toBeNull();
  });

  it("only treats a slash as a command at the start of the message", () => {
    expect(readTrigger("/new", 4)).toMatchObject({ char: "/", query: "new" });
    expect(readTrigger("see docs/api", 12)).toBeNull();
    expect(readTrigger("run /new", 8)).toBeNull();
  });

  it("reads the trigger before the caret, not at the end", () => {
    // Editing mid-sentence has to work the same as typing at the end.
    expect(readTrigger("see @not and more", 8)).toMatchObject({ query: "not" });
  });

  it("is null once the mention is finished with a space", () => {
    expect(readTrigger("see @file:a.md ", 15)).toBeNull();
  });
});

describe("applySuggestion", () => {
  it("replaces the trigger and its query, and leaves the rest", () => {
    const trigger = readTrigger("look at @not", 12)!;
    expect(applySuggestion("look at @not", trigger, pick)).toEqual({
      text: "look at @file:notes.md ",
      caret: 23,
    });
  });

  it("keeps text after the caret", () => {
    const trigger = readTrigger("see @not and more", 8)!;
    const out = applySuggestion("see @not and more", trigger, pick);
    expect(out.text).toBe("see @file:notes.md  and more");
  });
});

describe("narrowing by kind", () => {
  it("keeps a half-typed reference live", () => {
    // Backspacing into @file:notes/a used to leave a dead string, because the
    // query stopped at the first slash.
    expect(readTrigger("see @file:notes/a", 17)).toMatchObject({
      char: "@",
      query: "file:notes/a",
    });
  });

  it("splits a query into the kind and the term", () => {
    expect(splitQuery("file:notes/a")).toEqual({ kind: "file", term: "notes/a" });
    expect(splitQuery("file:")).toEqual({ kind: "file", term: "" });
  });

  it("treats a colon that is not a kind as part of the term", () => {
    expect(splitQuery("time:30")).toEqual({ term: "time:30" });
  });

  it("has no kind before one is typed", () => {
    expect(splitQuery("budget")).toEqual({ term: "budget" });
  });

  it("leaves the caret inside a partial insertion", () => {
    // Picking the kind is half a reference; a trailing space would end it.
    const trigger = readTrigger("see @fi", 7)!;
    const out = applySuggestion("see @fi", trigger, {
      insert: "@file:",
      label: "file:",
      kind: "file",
      partial: true,
    });
    expect(out.text).toBe("see @file:");
    expect(out.caret).toBe(10);
  });

  it("still finishes a whole reference with a space", () => {
    const trigger = readTrigger("see @fi", 7)!;
    const out = applySuggestion("see @fi", trigger, {
      insert: "@file:a.md",
      label: "a.md",
      kind: "file",
    });
    expect(out.text).toBe("see @file:a.md ");
  });
});

describe("a command's argument", () => {
  it("is offered after the verb and a space, for the commands that take a thing", () => {
    expect(readTrigger("/switch bud", 11)).toEqual({ char: "arg", query: "bud", at: 8, command: "switch" });
    expect(readTrigger("/goto ", 6)).toEqual({ char: "arg", query: "", at: 6, command: "switch" });
    expect(readTrigger("/approve #1", 11)).toMatchObject({ char: "arg", query: "#1", command: "approve" });
    expect(readTrigger("/no 3", 5)).toMatchObject({ command: "deny" });
  });

  it("names the agent of a dispatch, and stops at the colon where the task starts", () => {
    expect(readTrigger("/dispatch Til", 13)).toMatchObject({ char: "arg", query: "Til", command: "dispatch" });
    expect(readTrigger("/dispatch Tiles: pick", 21)).toBeNull();
  });

  it("is nothing for a command that takes prose, or none", () => {
    expect(readTrigger("/rename Budget", 14)).toBeNull();
    expect(readTrigger("/status ", 8)).toBeNull();
    expect(readTrigger("/brief keep it short", 20)).toBeNull();
  });

  it("replaces only the argument when picked", () => {
    const trigger = readTrigger("/switch bud", 11)!;
    expect(applySuggestion("/switch bud", trigger, { insert: "Budget review", label: "Budget review", kind: "chat" })).toEqual({
      text: "/switch Budget review ",
      caret: 22,
    });
    const dispatch = readTrigger("/dispatch Ti", 12)!;
    const out = applySuggestion("/dispatch Ti", dispatch, { insert: "Tiles: ", label: "Tiles", kind: "chat", partial: true });
    expect(out.text).toBe("/dispatch Tiles: ");
    // The caret sits where the task goes.
    expect(out.caret).toBe(out.text.length);
  });
});
