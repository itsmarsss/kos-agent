import { describe, expect, it } from "vitest";

import { listAt, type MdList } from "./lists.js";

const read = (text: string, at = 0): { list: MdList; next: number } | undefined => listAt(text.split("\n"), at);
const bodies = (text: string): string[] => read(text)?.list.items.map((i) => i.body) ?? [];

describe("a list", () => {
  it("gives each item the lines under it, indent taken off, nested markers and all", () => {
    expect(bodies("- fruit\n  - apple\n  - pear\n- veg\n    - leek")).toEqual(["fruit\n- apple\n- pear", "veg\n  - leek"]);
    // The nested list is found again when the item is read.
    expect(read("apple\n- a\n- b", 1)?.list.items.map((i) => i.body)).toEqual(["a", "b"]);
  });

  it("keeps a numbered list's count across the bullets under a step, however they are indented", () => {
    const r = read("1. Install\n  - brew install x\n2. Run\n3. Check\n   1. logs\n   2. ports");
    expect(r?.list).toMatchObject({ ordered: true, start: 1 });
    expect(r?.list.items.map((i) => i.body)).toEqual(["Install\n- brew install x", "Run", "Check\n1. logs\n2. ports"]);
    expect(r?.next).toBe(6);
  });

  it("holds a code block inside an item, even one written flush left", () => {
    expect(bodies("1. Run:\n   ```bash\n   npm i\n   ```\n2. Next")).toEqual(["Run:\n```bash\nnpm i\n```", "Next"]);
    const r = read("- Example:\n  ```\ndef f():\n    return 1\n  ```\n\nAfter\n\n```\nreal\n```");
    expect(r?.list.items.map((i) => i.body)).toEqual(["Example:\n```\ndef f():\n    return 1\n```"]);
    // The list ends before "After", and the fences after it are untouched.
    expect(r?.next).toBe(5);
  });

  it("holds math, quotes and words written after a nested list, in their order", () => {
    expect(bodies("1. Formula:\n   $$\n   E = mc^2\n   $$")).toEqual(["Formula:\n$$\nE = mc^2\n$$"]);
    expect(bodies("- a\n  - b\n  more of a")).toEqual(["a\n- b\nmore of a"]);
    expect(bodies("- note\n  > quoted\n  -# source")).toEqual(["note\n> quoted\n-# source"]);
  });

  it("goes on across a blank line, keeps it inside an item, and starts where it was numbered", () => {
    const r = read("3. c\n\n4. d\n\n   more of d\n\nafter");
    expect(r?.list).toMatchObject({ start: 3 });
    expect(r?.list.items.map((i) => i.body)).toEqual(["c", "d\n\nmore of d"]);
    expect(r?.next).toBe(5);
  });

  it("reads numbers aligned to the right as one list, and tabs as indent", () => {
    expect(bodies(" 9. nine\n10. ten")).toEqual(["nine", "ten"]);
    expect(bodies("-\tfirst\n\t- under")).toEqual(["first\n- under"]);
  });

  it("ends at an unindented paragraph and at the other kind of list", () => {
    expect(read("- a\nnot an item")).toEqual({ list: { ordered: false, start: 1, items: [{ body: "a" }] }, next: 1 });
    expect(read("- a\n1. one")?.next).toBe(1);
  });

  it("keeps a line separator inside an item, and is nothing on a line that is not one", () => {
    expect(bodies("- a b")).toEqual(["a b"]);
    expect(read("just words")).toBeUndefined();
    expect(read("-not a bullet")).toBeUndefined();
    expect(read("-# small print")).toBeUndefined();
  });
});
