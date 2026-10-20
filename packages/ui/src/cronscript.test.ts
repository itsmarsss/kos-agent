import { describe, expect, it } from "vitest";

import { scriptIn, withScript } from "./cronscript.js";

describe("the script a job runs", () => {
  const post = { tool: "notify", args: { text: "{text}" } };

  it("is read from the first skills.run call, and nothing from a job without one", () => {
    expect(scriptIn(JSON.stringify([{ tool: "skills.run", args: { name: "board" } }, post]))).toBe("board");
    expect(scriptIn(JSON.stringify([post]))).toBe("");
    expect(scriptIn("not json")).toBe("");
  });

  it("is written into that call, put first when there was none, and taken out by an empty pick", () => {
    expect(JSON.parse(withScript(JSON.stringify([post]), "board"))).toEqual([{ tool: "skills.run", args: { name: "board" } }, post]);
    expect(JSON.parse(withScript(JSON.stringify([{ tool: "skills.run", args: { name: "old" } }, post]), "board"))).toEqual([{ tool: "skills.run", args: { name: "board" } }, post]);
    expect(JSON.parse(withScript(JSON.stringify([{ tool: "skills.run", args: { name: "old" } }, post]), ""))).toEqual([post]);
    // Broken JSON starts over with the pick alone.
    expect(JSON.parse(withScript("{", "board"))).toEqual([{ tool: "skills.run", args: { name: "board" } }]);
  });
});
