import { describe, expect, it } from "vitest";

import { listAt, type MdList } from "./lists.js";

const read = (text: string, at = 0): { list: MdList; next: number } | undefined => listAt(text.split("\n"), at);
const item = (text: string, ...lists: MdList[]) => ({ text, lists });
const bullets = (...items: ReturnType<typeof item>[]): MdList => ({ ordered: false, start: 1, items });
const numbered = (start: number, ...items: ReturnType<typeof item>[]): MdList => ({ ordered: true, start, items });

describe("a list", () => {
  it("nests an item deeper than its marker under the one before", () => {
    expect(read("- fruit\n  - apple\n  - pear\n- veg\n    - leek")?.list).toEqual(
      bullets(item("fruit", bullets(item("apple"), item("pear"))), item("veg", bullets(item("leek")))),
    );
  });

  it("keeps a numbered list's count across the bullets under a step", () => {
    const r = read("1. Install\n   - brew install x\n2. Run\n3. Check\n   1. logs\n   2. ports");
    expect(r?.list).toEqual(
      numbered(1, item("Install", bullets(item("brew install x"))), item("Run"), item("Check", numbered(1, item("logs"), item("ports")))),
    );
    expect(r?.next).toBe(6);
  });

  it("goes three deep, and comes back out to the right level", () => {
    expect(read("- a\n  - b\n    - c\n  - d\n- e")?.list).toEqual(bullets(item("a", bullets(item("b", bullets(item("c"))), item("d"))), item("e")));
  });

  it("carries an indented line on the item above, and reads tabs as indent", () => {
    expect(read("- first\n  more of it\n-\tsecond\n\t- under")?.list).toEqual(bullets(item("first\nmore of it"), item("second", bullets(item("under")))));
  });

  it("goes on across a blank line, and starts where it was numbered", () => {
    expect(read("3. c\n\n4. d\n\n   - note\n\nafter")).toEqual({ list: numbered(3, item("c"), item("d", bullets(item("note")))), next: 5 });
  });

  it("ends at a paragraph, and at the other kind at its own depth", () => {
    expect(read("- a\nnot an item")).toEqual({ list: bullets(item("a")), next: 1 });
    expect(read("- a\n1. one")).toEqual({ list: bullets(item("a")), next: 1 });
  });

  it("is nothing on a line that is not an item", () => {
    expect(read("just words")).toBeUndefined();
    expect(read("-not a bullet")).toBeUndefined();
  });
});
