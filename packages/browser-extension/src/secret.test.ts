import { isSecretSlot, type SecretSlot } from "@kos/browser";
import { describe, expect, it } from "vitest";

import { withoutFieldText } from "./relay.js";
import { SLOTS, editsField, heldNow, heldRefusal, hiddenValues, isSecret, marked, movedWithin, readMasks, readPut, readTaints, typesText, type TabTaint } from "./secret.js";

/**
 * What the extension reads of a secret's fill, and what it holds a tab to
 * after one, as pure functions: the parts secretfill.chrome.test.ts runs in
 * a real Chrome.
 */

const put = { node: 41, frame: "F", doc: "L1", origin: "https://github.com", frameOrigin: "https://github.com", slot: "password", value: "hunter2-canary" };

describe("a secret's fill as KOS sends it", () => {
  it("reads one field's fill, and refuses one missing a part or of a kind of field it does not know, never saying the value", () => {
    expect(readPut(put)).toEqual(put);
    for (const bad of [{ ...put, node: "41" }, { ...put, frame: "" }, { ...put, doc: undefined }, { ...put, slot: "pin" }, { ...put, value: "" }, { ...put, value: "x".repeat(8_193) }]) {
      expect(() => readPut(bad)).toThrow(expect.objectContaining({ code: "bad_request" }));
      try {
        readPut(bad);
      } catch (err) {
        expect((err as Error).message).not.toContain("hunter2");
      }
    }
  });

  it("knows the slots KOS's hands do, and which of them hold a secret", () => {
    for (const slot of SLOTS) expect(isSecret(slot)).toBe(isSecretSlot(slot as SecretSlot));
    expect(SLOTS).toHaveLength(16);
  });

  it("reads masks by origin and nothing else", () => {
    expect(readMasks({ "https://github.com": ["a(?:b)"] })).toEqual({ "https://github.com": ["a(?:b)"] });
    for (const bad of [[], { "github.com": ["a"] }, { "https://github.com": "a" }, { "https://github.com": [""] }, { "https://github.com": Array(501).fill("a") }]) {
      expect(() => readMasks(bad)).toThrow(expect.objectContaining({ code: "bad_request" }));
    }
  });
});

describe("a tab a secret was filled into", () => {
  const field = { frame: "F", node: 41 };

  it("is held to its fields until its document changes, and as a whole page when that document is come back to", () => {
    const taint = marked(undefined, "L1", "https://github.com/login#top", field);
    expect(taint).toEqual({ loader: "L1", nodes: [field], urls: ["https://github.com/login"] });
    expect(heldNow(taint, "L1", "https://github.com/login")).toEqual({ nodes: [field] });
    expect(heldNow(taint, "L2", "https://github.com/session")).toBeUndefined();
    // Back, forward or a reload: the browser may put what was typed back.
    expect(heldNow(taint, "L3", "https://github.com/login#again")).toEqual({ nodes: [] });
    expect(heldNow(undefined, "L1", "https://github.com/login")).toBeUndefined();
    // A second field of the same document joins it; one of a new document starts afresh, the addresses kept.
    const two = marked(taint, "L1", "https://github.com/login", { frame: "F", node: 42 });
    expect(two.nodes).toHaveLength(2);
    expect(marked(two, "L4", "https://github.com/2fa", field)).toEqual({ loader: "L4", nodes: [field], urls: ["https://github.com/login", "https://github.com/2fa"] });
  });

  it("keeps each address its document moves to by itself, and no other document's", () => {
    const taint = marked(undefined, "L1", "https://github.com/login", field);
    const moved = movedWithin(taint, "L1", "https://github.com/login/2fa#code");
    expect(moved?.urls).toEqual(["https://github.com/login", "https://github.com/login/2fa"]);
    // Come back to the new address as a new document: held as a page the secret was in.
    expect(heldNow(moved, "L9", "https://github.com/login/2fa")).toEqual({ nodes: [] });
    expect(movedWithin(moved, "L1", "https://github.com/login/2fa")).toBeUndefined();
    expect(movedWithin(taint, "L2", "https://github.com/elsewhere")).toBeUndefined();
    expect(movedWithin(undefined, "L1", "https://github.com/login/2fa")).toBeUndefined();
  });

  it("is kept in session storage as it was, anything else dropped", () => {
    const taint: TabTaint = { loader: "L1", nodes: [field], urls: ["https://github.com/login"] };
    expect(readTaints(JSON.parse(JSON.stringify({ 7: taint, x: taint, 8: { loader: 1 }, 9: { ...taint, nodes: [{ frame: "F" }, field] } })))).toEqual(
      new Map([
        [7, taint],
        [9, taint],
      ]),
    );
    expect(readTaints(undefined).size).toBe(0);
    // A field in a frame of another process keeps the frame whose session holds it.
    const framed: TabTaint = { loader: "L1", nodes: [{ frame: "P", node: 7, via: "P" }], urls: [] };
    expect(readTaints(JSON.parse(JSON.stringify({ 3: framed, 4: { ...framed, nodes: [{ frame: "P", node: 7, via: 9 }] } })))).toEqual(new Map([[3, framed], [4, { ...framed, nodes: [] }]]));
  });

  it("refuses KOS's script step, a copy, a cut, a select-all and a drag, and lets the rest of its hands through", () => {
    expect(heldRefusal("Runtime.evaluate", { expression: "1", replMode: true })).toMatch(/script/);
    expect(heldRefusal("Runtime.evaluate", { expression: "1", uniqueContextId: "u" })).toMatch(/script/);
    for (const key of [
      { key: "c", modifiers: 2 },
      { key: "x", modifiers: 4 },
      { code: "KeyA", modifiers: 4 },
      { windowsVirtualKeyCode: 67, modifiers: 2 },
      { key: "Enter", commands: ["copy"] },
      { key: "Enter", commands: ["selectAll"] },
      { key: "Insert", modifiers: 2 },
      { key: "Insert", code: "Insert", modifiers: 8 },
      { key: "Delete", modifiers: 8 },
      { windowsVirtualKeyCode: 45, modifiers: 4 },
      { key: "k", commands: ["deleteToEndOfParagraph"] },
      { key: "y", commands: ["yank"] },
      { key: "Backspace", commands: ["deleteWordBackward"] },
    ]) {
      expect(heldRefusal("Input.dispatchKeyEvent", { type: "keyDown", ...key })).toMatch(/copying/);
    }
    expect(heldRefusal("Input.dispatchDragEvent", { type: "drop" })).toMatch(/dragging/);
    expect(heldRefusal("Input.setInterceptDrags", { enabled: true })).toMatch(/dragging/);
    expect(heldRefusal("Input.setInterceptDrags", { enabled: false })).toBeUndefined();
    // The hands' own reads and acts in their world, a plain key, a shifted letter, a click.
    expect(heldRefusal("Runtime.evaluate", { expression: "1", contextId: 3 })).toBeUndefined();
    expect(heldRefusal("Runtime.callFunctionOn", { objectId: "1.3.1", functionDeclaration: "function () {}" })).toBeUndefined();
    expect(heldRefusal("Input.dispatchKeyEvent", { type: "keyDown", key: "c", modifiers: 8 })).toBeUndefined();
    expect(heldRefusal("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter" })).toBeUndefined();
    expect(heldRefusal("Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 1 })).toBeUndefined();
  });

  it("knows a key event that carries an editing command, which a filled field refuses", () => {
    expect(editsField("Input.dispatchKeyEvent", { type: "keyDown", key: "v", commands: ["paste"] })).toBe(true);
    expect(editsField("Input.dispatchKeyEvent", { type: "keyDown", key: "v", commands: [] })).toBe(false);
    expect(editsField("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter" })).toBe(false);
    expect(editsField("Input.insertText", { text: "x", commands: ["paste"] })).toBe(false);
  });

  it("knows a command that types text from one that does not", () => {
    expect(typesText("Input.insertText", { text: "x" })).toBe(true);
    expect(typesText("Input.dispatchKeyEvent", { type: "char", text: "x" })).toBe(true);
    expect(typesText("Input.dispatchKeyEvent", { type: "keyDown", key: "x", text: "x" })).toBe(true);
    expect(typesText("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab" })).toBe(false);
    expect(typesText("Input.dispatchKeyEvent", { type: "keyUp", key: "x" })).toBe(false);
    expect(typesText("DOM.focus", {})).toBe(false);
  });
});

describe("what the browser says a field holds", () => {
  it("keeps the browser's own shadow roots, which hold each field's text, out of a read of the DOM", () => {
    const text = { nodeType: 3, nodeValue: "hunter2-canary", backendNodeId: 9 };
    const input = { backendNodeId: 41, shadowRoots: [{ shadowRootType: "user-agent", children: [{ backendNodeId: 8, children: [text] }] }, { shadowRootType: "open", children: [] }] };
    const answer = { root: { backendNodeId: 1, children: [{ backendNodeId: 2, contentDocument: { backendNodeId: 3, children: [input] } }] } };
    expect(JSON.stringify(withoutFieldText("DOM.getDocument", structuredClone(answer)))).not.toContain("hunter2");
    expect(JSON.stringify(withoutFieldText("DOM.describeNode", { node: structuredClone(input) }))).toBe('{"node":{"backendNodeId":41,"shadowRoots":[{"shadowRootType":"open","children":[]}]}}');
    expect(withoutFieldText("Page.getFrameTree", answer)).toBe(answer);
  });

  it("says a filled field holds (hidden) in the accessibility tree, and leaves out the editor inside it", () => {
    const nodes = [
      { nodeId: "1", childIds: ["2", "5"] },
      { nodeId: "2", backendDOMNodeId: 41, role: { value: "textbox" }, value: { type: "string", value: "4242424242424242" }, childIds: ["3"] },
      { nodeId: "3", childIds: ["4"] },
      { nodeId: "4", name: { value: "4242424242424242" } },
      { nodeId: "5", backendDOMNodeId: 50, value: { type: "string", value: "owner" } },
    ];
    const answer = hiddenValues("Accessibility.getFullAXTree", { nodes: structuredClone(nodes) }, { nodes: [{ frame: "F", node: 41 }] });
    expect(JSON.stringify(answer)).not.toContain("4242");
    expect((answer["nodes"] as { nodeId: string }[]).map((n) => n.nodeId)).toEqual(["1", "2", "5"]);
    expect(answer["nodes"]).toContainEqual(expect.objectContaining({ nodeId: "2", value: { type: "string", value: "(hidden)" }, childIds: [] }));
    expect(answer["nodes"]).toContainEqual(expect.objectContaining({ nodeId: "5", value: { type: "string", value: "owner" } }));
    expect(hiddenValues("Accessibility.getFullAXTree", { nodes }, undefined)["nodes"]).toBe(nodes);
    // A page a secret was in come back to: every text box's value, since which holds it again is not known.
    const back = hiddenValues("Accessibility.getFullAXTree", { nodes: structuredClone(nodes) }, { nodes: [] });
    expect(JSON.stringify(back)).not.toContain("4242");
    expect(back["nodes"]).toContainEqual(expect.objectContaining({ nodeId: "5", value: { type: "string", value: "owner" } }));
    // A backend node is its process's own: a field filled in a frame of another process is that frame session's alone.
    const inFrame = { nodes: [{ frame: "P", node: 41, via: "P" }] };
    expect(JSON.stringify(hiddenValues("Accessibility.getFullAXTree", { nodes: structuredClone(nodes) }, inFrame))).toContain("4242");
    expect(JSON.stringify(hiddenValues("Accessibility.getFullAXTree", { nodes: structuredClone(nodes) }, inFrame, "P"))).not.toContain("4242");
    const box = { nodeId: "6", backendDOMNodeId: 60, role: { value: "searchbox" }, value: { type: "string", value: "typed" } };
    expect(hiddenValues("Accessibility.getFullAXTree", { nodes: [structuredClone(box)] }, { nodes: [] })["nodes"]).toEqual([{ ...box, value: { type: "string", value: "(hidden)" }, childIds: [] }]);
  });
});
