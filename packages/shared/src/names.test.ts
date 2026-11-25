import { describe, expect, it } from "vitest";

import { assertName, checkName, NAME_MAX, NameError, nameRefusal } from "./names.js";
import { errorWords } from "./errorwords.js";
import { stepLine, toolWords, TOOL_WORDS } from "./toolwords.js";

describe("the one name check", () => {
  const rules = { noun: "project", taken: ["Home lab", "Reading log"] };

  it("takes a plain name, trimmed", () => {
    expect(checkName("  Garden  ", rules)).toBeNull();
    expect(assertName("  Garden  ", rules)).toBe("Garden");
  });

  it("asks for a name when there is none", () => {
    expect(checkName("   ", rules)).toEqual({ problem: "empty", message: "Give the project a name." });
  });

  it("refuses one past the limit and says the limit", () => {
    const long = "a".repeat(NAME_MAX + 1);
    const check = checkName(long, rules);
    expect(check?.problem).toBe("too_long");
    expect(check?.message).toContain(String(NAME_MAX));
    expect(checkName("a".repeat(NAME_MAX), rules)).toBeNull();
    expect(checkName("abcdef", { ...rules, max: 5 })?.problem).toBe("too_long");
  });

  it("refuses a taken name whatever its case or spaces, naming the one it clashes with", () => {
    const check = checkName(" home LAB ", rules);
    expect(check?.problem).toBe("taken");
    expect(check?.message).toBe("There is already a project called “Home lab”. Pick another name.");
  });

  it("refuses line breaks and names with no letter or digit", () => {
    expect(checkName("Q1/Q2 plan", rules)).toBeNull();
    expect(checkName("a\nb", rules)?.problem).toBe("invalid");
    expect(checkName("!!!", rules)?.problem).toBe("invalid");
    expect(checkName("Café 2", rules)).toBeNull();
  });

  it("holds a folder's name to letters, digits and dashes", () => {
    expect(checkName("plant-watcher", { noun: "blob", plain: true })).toBeNull();
    expect(checkName("plant watcher", { noun: "blob", plain: true })?.problem).toBe("invalid");
  });

  it("carries a refusal to the route and the wire", () => {
    let thrown: unknown;
    try {
      assertName("Home lab", rules);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(NameError);
    const check = (thrown as NameError).check;
    expect(nameRefusal(check)).toEqual({ error: check.message, field: "name", problem: "taken" });
  });
});

describe("tool words", () => {
  it("say each step as an action in sentence case, never its name", () => {
    for (const [tool, words] of Object.entries(TOOL_WORDS)) {
      expect(words[0], tool).toBe(words[0]!.toUpperCase());
      expect(words, tool).not.toMatch(/[._]/);
    }
    expect(toolWords("files.ls")).toBe("List files");
    expect(toolWords("secrets.write")).toBe("Save a secret");
  });

  it("fall back to the family, a server's tool by its server, then plain words", () => {
    expect(toolWords("files.chmod")).toBe("Work with files");
    expect(toolWords("mcp.gmail.send_email")).toBe("Send email on gmail");
    expect(toolWords("weird_tool")).toBe("Weird tool");
  });
});

describe("a step as a row says it", () => {
  it("is what it did, and what to, never an id, a handle or the raw arguments", () => {
    expect(stepLine("files.read", { path: "notes/todo.md" })).toEqual({ title: "Read a file", detail: "notes/todo.md" });
    expect(stepLine("files.ls", JSON.stringify({ path: "notes" }))).toEqual({ title: "List files", detail: "notes" });
    expect(stepLine("artifact.trash", { id: "reading-shelf" })).toEqual({ title: "Move an artifact to the trash" });
    expect(stepLine("secrets.write", { handle: "visa-ending-4242-d6xh", kind: "card", fields: ["number"] })).toEqual({ title: "Save a secret" });
    expect(stepLine("http.fetch", "not json")).toEqual({ title: "Fetch a web address" });
    expect(stepLine("notify", { quiet: "nothing new above the bar" })).toEqual({ title: "Chose not to post", detail: "nothing new above the bar" });
  });

  it("cuts a long target to one short line", () => {
    const { detail } = stepLine("shell.run", { command: `echo ${"x".repeat(200)}\nls` });
    expect(detail!.length).toBe(80);
    expect(detail!.endsWith("…")).toBe(true);
  });
});

describe("error words", () => {
  it("say a missing file by its name, never the host's path", () => {
    const said = errorWords("tool error: ENOENT: no such file or directory, open '/Users/me/kos-workspace/notes/missing-file.md'");
    expect(said).toBe("There is no file or folder called “missing-file.md”.");
    expect(said).not.toContain("/Users");
  });

  it("say the store's refusals in plain words", () => {
    expect(errorWords("UNIQUE constraint failed: manifest.name")).toBe("That name is taken. Pick another.");
    expect(errorWords("invalid cron schedule: 0 99 * * *")).toBe("That isn't a schedule KOS can read.");
  });

  it("keep an unknown message, its prefix gone and paths cut", () => {
    expect(errorWords("Error: the page at /Users/me/ws/notes/a.md was odd")).toBe("The page at a.md was odd");
    expect(errorWords("")).toBe("Something went wrong.");
  });
});
