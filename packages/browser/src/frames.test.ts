import { describe, expect, it } from "vitest";

import { partOf, tabMap, webOrigin, type Reach, type Send } from "./frames.js";

/** One session of a fake tab: its frame tree and its DOM. */
const session = (tree: unknown, root: unknown): Send => async (method) => (method === "Page.getFrameTree" ? { frameTree: tree } : method === "DOM.getDocument" ? { root } : {});

/** A checkout whose card frame is of another site: its element in the tab with no document, its page in a session of its own. */
const TAB = session(
  { frame: { id: "F", loaderId: "L", securityOrigin: "https://shop.example" } },
  { backendNodeId: 1, nodeType: 9, children: [{ backendNodeId: 2, nodeType: 1, children: [{ backendNodeId: 3, nodeType: 1, frameId: "P" }] }] },
);
const PAY = session(
  { frame: { id: "P", parentId: "F", loaderId: "M", securityOrigin: "https://js.stripe.com" }, childFrames: [{ frame: { id: "B", securityOrigin: "://" } }] },
  {
    backendNodeId: 1,
    nodeType: 9,
    children: [
      { backendNodeId: 2, nodeType: 1 },
      { backendNodeId: 5, nodeType: 1, frameId: "B", contentDocument: { backendNodeId: 6, nodeType: 9 } },
    ],
  },
);

describe("a tab's frames across its processes", () => {
  it("reads a frame of another process through its own session, its nodes its own", async () => {
    const reach: Reach = { send: TAB, frame: (id) => (id === "P" ? PAY : undefined) };
    const map = await tabMap(reach);
    expect(map.main).toBe("F");
    expect(map.frames.get("P")).toEqual({ origin: "https://js.stripe.com", loader: "M", parent: "F", via: "P" });
    expect(map.frames.get("B")).toMatchObject({ parent: "P", via: "P" });
    // The same backend id in two processes is two nodes.
    expect(map.parts.get("")?.frameOf.get(2)).toBe("F");
    expect(map.parts.get("P")?.frameOf.get(2)).toBe("P");
    expect(partOf(map, "B")?.send).toBe(PAY);
    expect(map.parts.get("P")?.roots.get("B")).toEqual([6]);
    expect(webOrigin(map, "B")).toBe("https://js.stripe.com");
    expect(map.unreached.size).toBe(0);
  });

  it("names a frame no session reaches, by the element it sits in, and takes nothing of a session that answers for another frame", async () => {
    const none = await tabMap({ send: TAB, frame: () => undefined });
    expect(none.unreached.get("P")).toEqual({ via: "", owner: 3 });
    expect(none.frames.has("P")).toBe(false);
    // A browser that sends a frame's commands to the tab (a KOS for Chrome from before frames) answers with the tab's own tree.
    const wrong = await tabMap({ send: TAB, frame: () => TAB });
    expect(wrong.unreached.has("P")).toBe(true);
    expect([...wrong.frames.values()].every((f) => f.via === "")).toBe(true);
    expect(wrong.parts.has("P")).toBe(false);
  });
});
