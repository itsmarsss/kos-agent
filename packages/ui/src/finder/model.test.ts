import { describe, expect, it } from "vitest";

import type { DirEntry } from "../api.js";
import { EMPTY_SELECTION, clickSelect, dateWords, fileMention, freeName, kindOf, moveLead, only, sizeWords, sortEntries, trail, typeSelect } from "./model.js";

const e = (name: string, kind: "dir" | "file" = "file", size = 0, modifiedAt = 0): DirEntry => ({ name, path: `p/${name}`, kind, size, modifiedAt });

describe("the finder's rules", () => {
  it("sorts folders first, names as people read them, any column either way", () => {
    const list = [e("b10.txt", "file", 5, 3), e("b2.txt", "file", 50, 1), e("z", "dir"), e("A.md", "file", 1, 2)];
    expect(sortEntries(list, { key: "name", desc: false }).map((x) => x.name)).toEqual(["z", "A.md", "b2.txt", "b10.txt"]);
    expect(sortEntries(list, { key: "size", desc: true }).map((x) => x.name)).toEqual(["z", "b2.txt", "b10.txt", "A.md"]);
    expect(sortEntries(list, { key: "modified", desc: false }).map((x) => x.name)).toEqual(["z", "b2.txt", "A.md", "b10.txt"]);
    expect(sortEntries(list, { key: "kind", desc: false }).map((x) => x.name)).toEqual(["z", "A.md", "b2.txt", "b10.txt"]);
  });

  it("names kinds, sizes and dates as Finder does", () => {
    expect(kindOf(e("plan.docx"))).toBe("Word document");
    expect(kindOf(e("x", "dir"))).toBe("Folder");
    expect(kindOf(e("thing.qqq"))).toBe("QQQ file");
    expect(sizeWords(1)).toBe("1 byte");
    expect(sizeWords(999)).toBe("999 bytes");
    expect(sizeWords(1500)).toBe("1.5 KB");
    expect(sizeWords(61_825)).toBe("62 KB");
    expect(sizeWords(3_200_000)).toBe("3.2 MB");
    const now = new Date(2026, 10, 18, 15, 0).getTime();
    expect(dateWords(new Date(2026, 10, 18, 9, 5).getTime(), now)).toMatch(/^Today at 9:05/);
    expect(dateWords(new Date(2026, 10, 17, 9, 5).getTime(), now)).toMatch(/^Yesterday at/);
    expect(dateWords(new Date(2025, 0, 3).getTime(), now)).toMatch(/2025 at/);
  });

  it("selects by click, Cmd and Shift, and moves the lead with the keys", () => {
    const order = ["a", "b", "c", "d"];
    let sel = clickSelect(EMPTY_SELECTION, "b", order, {});
    expect(sel).toEqual(only("b"));
    sel = clickSelect(sel, "d", order, { shift: true });
    expect(sel.paths).toEqual(["b", "c", "d"]);
    sel = clickSelect(sel, "c", order, { meta: true });
    expect(sel.paths).toEqual(["b", "d"]);
    sel = clickSelect(sel, "a", order, { meta: true });
    expect(sel.paths).toEqual(["b", "d", "a"]);
    expect(moveLead(only("b"), order, 1, false)).toEqual(only("c"));
    expect(moveLead(only("d"), order, 1, false)).toEqual(only("d"));
    expect(moveLead(only("b"), order, 2, true).paths).toEqual(["b", "c", "d"]);
    expect(moveLead(EMPTY_SELECTION, order, -1, false)).toEqual(only("d"));
  });

  it("types to select, names new folders, and writes references", () => {
    const list = [e("apple"), e("banana"), e("Bandit")];
    expect(typeSelect(list, "ban")).toBe("p/banana");
    expect(typeSelect(list, "BAND")).toBe("p/Bandit");
    expect(typeSelect(list, "x")).toBeUndefined();
    expect(freeName(["untitled folder", "Untitled Folder 2"], "untitled folder")).toBe("untitled folder 3");
    expect(fileMention("projects/a.md")).toBe("@file:projects/a.md");
    expect(fileMention("projects/Garden plan.docx")).toBe("@file:[projects/Garden plan.docx]");
    expect(trail("projects/garden/plans", "projects/garden", "Garden").map((s) => s.name)).toEqual(["Garden", "plans"]);
    expect(trail("a/b", ".", "Workspace").map((s) => s.path)).toEqual([".", "a", "a/b"]);
  });
});
