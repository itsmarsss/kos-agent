import { describe, expect, it } from "vitest";

import { indexOf, Refs, treeOf, type AxNode } from "./snapshot.js";

/** A tree as Chrome reports one: flat, linked by ids. */
function tree(spec: [id: string, parent: string | null, role: string, name?: string, backend?: number, extra?: Partial<AxNode>][]): AxNode[] {
  const nodes = spec.map(([nodeId, parent, role, name, backend, extra]) => ({
    nodeId,
    ...(parent ? { parentId: parent } : {}),
    role: { value: role },
    ...(name !== undefined ? { name: { value: name } } : {}),
    ...(backend !== undefined ? { backendDOMNodeId: backend } : {}),
    childIds: [] as string[],
    ...extra,
  }));
  for (const n of nodes) if (n.parentId) nodes.find((p) => p.nodeId === n.parentId)!.childIds.push(n.nodeId);
  return nodes;
}

const SHOP = tree([
  ["1", null, "RootWebArea", "Shop"],
  ["2", "1", "generic", undefined, 2],
  ["3", "2", "heading", "Cart", 3, { properties: [{ name: "level", value: { value: 2 } }] }],
  ["4", "2", "textbox", "Email", 4, { value: { value: "ada@example.com" } }],
  ["5", "2", "checkbox", "Gift wrap", 5, { properties: [{ name: "checked", value: { value: "false" } }] }],
  ["6", "2", "button", "Add to cart", 6],
  ["7", "2", "button", "Add to cart", 7],
  ["8", "2", "link", "reply", 8],
  ["9", "2", "link", "reply", 9],
  ["10", "2", "link", "", 10],
  ["11", "2", "StaticText", "Total 12 dollars", 11],
  ["12", "2", "button", "Hidden", 12, { ignored: true }],
]);

describe("the index of a page", () => {
  it("names each control by role, label, state and ref, folding links of one label and leaving unlabeled ones out", () => {
    const refs = new Refs();
    const { lines, total } = indexOf(SHOP, refs);
    expect(lines).toEqual([
      'textbox "Email" = "ada@example.com" @e1',
      'checkbox "Gift wrap" [unchecked] @e2',
      'button "Add to cart" @e3',
      'button "Add to cart" @e4',
      'link "reply" @e5 (+1 more like it)',
    ]);
    expect(total).toBe(5);
  });

  it("keeps an element's ref from one look to the next, and starts again for a new document", () => {
    const refs = new Refs();
    indexOf(SHOP, refs);
    expect(indexOf(SHOP, refs).lines[0]).toBe('textbox "Email" = "ada@example.com" @e1');
    expect(refs.nodeOf("e3")).toBe(6);
    refs.clear();
    expect(refs.nodeOf("e3")).toBeUndefined();
  });

  it("puts a dialog's controls first, under its name", () => {
    const page = tree([
      ["1", null, "RootWebArea", "News"],
      ["2", "1", "button", "Subscribe", 2],
      ["3", "1", "dialog", "Cookies", 3],
      ["4", "3", "button", "Accept all", 4],
    ]);
    // Refs follow the page's reading order; the dialog only comes first in the list.
    expect(indexOf(page, new Refs()).lines).toEqual(['In the dialog "Cookies":', '  button "Accept all" @e2', "On the page:", 'button "Subscribe" @e1']);
  });

  it("caps the list, and says how many there were", () => {
    const many = tree([["1", null, "RootWebArea", "Many"], ...Array.from({ length: 80 }, (_, i) => [`b${i}`, "1", "button", `B${i}`, 100 + i] as [string, string, string, string, number])]);
    const { lines, total } = indexOf(many, new Refs(), 60);
    expect(lines).toHaveLength(60);
    expect(total).toBe(80);
  });
});

describe("the outline of a page", () => {
  it("indents by what is shown, says headings' levels, and does not repeat a control's own words", () => {
    const page = tree([
      ["1", null, "RootWebArea", "Docs"],
      ["2", "1", "main", undefined, 2],
      ["3", "2", "heading", "Install", 3, { properties: [{ name: "level", value: { value: 1 } }] }],
      ["4", "3", "StaticText", "Install", 4],
      ["5", "2", "generic", undefined, 5],
      ["6", "5", "StaticText", "Run the script.", 6],
      ["7", "2", "link", "Download", 7],
      ["8", "7", "StaticText", "Download", 8],
    ]);
    expect(treeOf(page, new Refs()).text).toBe(
      ['- main @e1', '  - heading "Install" [level 1] @e2', '  - text "Run the script."', '  - link "Download" @e3'].join("\n"),
    );
  });

  it("is cut at its size, and says so", () => {
    const out = treeOf(SHOP, new Refs(), 60);
    expect(out.cut).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(60);
  });
});
