import { describe, expect, it } from "vitest";

import { act, stepsOf } from "./hands.js";
import * as inpage from "./inpage.js";
import { BrowserClock, Page, Stopped, type Session } from "./page.js";

type Handler = (params: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;

/** A tab's commands answered here: by the handlers given, the rest with nothing; each call kept. */
function tab(handlers: Record<string, Handler>): { session: Session; calls: { method: string; params: Record<string, unknown> }[] } {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const session: Session = {
    send: async (method, params = {}) => {
      calls.push({ method, params });
      const handler = handlers[method];
      return handler ? handler(params) : {};
    },
  };
  return { session, calls };
}

const FRAME = { frameTree: { frame: { id: "F", loaderId: "L", url: "https://shop.example/" } } };
/** Where the browser says the tab is. */
const HISTORY = { currentIndex: 0, entries: [{ id: 1, url: "https://shop.example/", title: "Shop" }] };
/** What the page itself finds to index: nothing, which is enough to see where it was looked from. */
const NOTHING = { result: [{ name: "kos", value: { value: JSON.stringify({ items: [], total: 0 }) } }] };
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

describe("KOS's own world in a page", () => {
  it("is asked for again after a Stop cut its making short, not taken to be missing", async () => {
    let made = 0;
    const { session, calls } = tab({
      "Page.getFrameTree": () => FRAME,
      "Page.createIsolatedWorld": () => (++made === 1 ? never() : { executionContextId: 9 }),
      "Runtime.evaluate": (p) => (p["contextId"] === 9 ? { result: { objectId: "found" } } : { result: { value: "complete" } }),
      "Runtime.getProperties": () => NOTHING,
    });
    const page = new Page(session);
    await page.ready();
    const stop = new AbortController();
    const pressing = page.step({ press: "Enter" }, stop.signal);
    setTimeout(() => stop.abort(), 50);
    await expect(pressing).rejects.toBeInstanceOf(Stopped);
    await page.index();
    expect(made).toBe(2);
    // Read from that world, not from the whole tree, as a tab with no world of KOS's own is.
    expect(calls.some((c) => c.method === "Accessibility.getFullAXTree")).toBe(false);
  });

  it("is asked for again after a failure, and not again where the browser refuses it", async () => {
    for (const [error, asked] of [[Object.assign(new Error("Cannot find context"), {}), 2], [Object.assign(new Error("not passed on"), { code: "method" }), 1]] as const) {
      let made = 0;
      const { session } = tab({
        "Page.getFrameTree": () => FRAME,
        "Page.createIsolatedWorld": () => {
          if (++made === 1) throw error;
          return { executionContextId: 9 };
        },
        "Runtime.evaluate": (p) => (p["contextId"] === 9 ? { result: { objectId: "found" } } : { result: { value: "complete" } }),
        "Runtime.getProperties": () => NOTHING,
        "Accessibility.getFullAXTree": () => ({ nodes: [] }),
      });
      const page = new Page(session);
      await page.ready();
      await page.index();
      await page.index();
      expect(made).toBe(asked);
    }
  });
});

describe("a wait for the page", () => {
  it("bounds each look for it by what is left of its grant", async () => {
    const asked: number[] = [];
    const session: Session = {
      send: async (method, _params, timeoutMs) => {
        if (method === "Runtime.evaluate") asked.push(timeoutMs ?? Infinity);
        return { result: { value: false } };
      },
    };
    const page = new Page(session);
    await expect(page.step({ wait: { text: "never", ms: 500 } })).rejects.toThrow(/waited 0.5s/);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((ms) => ms > 0 && ms <= 500)).toBe(true);
  });
});

describe("a Stop while the owner has the tab", () => {
  it("ends a step waiting for them to let go, and a call waiting its turn gives it up", async () => {
    // Held for the first two asks; let go by the third.
    let asked = 0;
    const page = new Page(tab({}).session, { gate: () => (++asked <= 2 ? never<boolean>() : Promise.resolve(false)) });
    const stop = new AbortController();
    const stepping = page.step({ press: "Enter" }, stop.signal);
    const waiting = page.run(async () => "ran", stop.signal);
    const next = page.run(async () => "next");
    setTimeout(() => stop.abort(), 20);
    await expect(stepping).rejects.toBeInstanceOf(Stopped);
    await expect(waiting).rejects.toBeInstanceOf(Stopped);
    await expect(next).resolves.toBe("next");
  });
});

describe("a Stop part way through a step", () => {
  /** A page with one element at every selector, a box at the top left, under nothing. */
  const shop = (more: Record<string, Handler> = {}): ReturnType<typeof tab> =>
    tab({
      "Page.getFrameTree": () => FRAME,
      "Runtime.evaluate": () => ({ result: { objectId: "el", value: "complete" } }),
      "DOM.describeNode": () => ({ node: { backendNodeId: 10 } }),
      "DOM.getContentQuads": () => ({ quads: [[0, 0, 20, 0, 20, 20, 0, 20]] }),
      "DOM.getNodeForLocation": () => ({ backendNodeId: 10 }),
      ...more,
    });

  it("lets go of the button of a drag stopped between its press and its release", async () => {
    const stop = new AbortController();
    const { session, calls } = shop({
      "Input.dispatchMouseEvent": (p) => {
        if (p["type"] === "mouseMoved" && p["buttons"] === 1) stop.abort();
        return {};
      },
    });
    const page = new Page(session);
    await page.ready();
    await expect(page.step({ drag: { from: "#card", to: "#done" } }, stop.signal)).rejects.toBeInstanceOf(Stopped);
    const mouse = calls.filter((c) => c.method === "Input.dispatchMouseEvent").map((c) => c.params["type"]);
    expect(mouse.indexOf("mouseReleased")).toBeGreaterThan(mouse.indexOf("mousePressed"));
    expect(calls.at(-1)).toEqual({ method: "Input.setInterceptDrags", params: { enabled: false } });
  });

  it("releases what a command no longer waited for brings back, once it does", async () => {
    let answer: (r: Record<string, unknown>) => void = () => undefined;
    const { session, calls } = shop({
      "Runtime.evaluate": (p) =>
        String(p["expression"]).includes("present") ? new Promise((r) => (answer = r)) : { result: { objectId: "el", value: "complete" } },
    });
    const page = new Page(session);
    await page.ready();
    const stop = new AbortController();
    const waiting = page.step({ wait: { text: "never there" } }, stop.signal);
    await new Promise((r) => setTimeout(r, 20));
    stop.abort();
    await expect(waiting).rejects.toBeInstanceOf(Stopped);
    answer({ result: { objectId: "late" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.filter((c) => c.method === "Runtime.releaseObject")).toEqual([{ method: "Runtime.releaseObject", params: { objectId: "late" } }]);
  });
});

describe("the time a page is given after typing", () => {
  it("is paid once for a run of fields filled in turn, after the last", async () => {
    // Each wait for the page to go still, with the least time it was given.
    const graces: number[] = [];
    const quiet = `(${inpage.domQuiet.toString()})(`;
    const { session } = tab({
      "Page.getFrameTree": () => FRAME,
      "Page.getNavigationHistory": () => HISTORY,
      "Page.createIsolatedWorld": () => ({ executionContextId: 9 }),
      "Runtime.evaluate": (p) => {
        const expression = String(p["expression"]);
        if (!expression.startsWith(quiet)) return { result: { objectId: "el", value: "complete" } };
        graces.push(Number(expression.slice(quiet.length).split(",")[1]));
        return { result: { value: true } };
      },
      "DOM.describeNode": () => ({ node: { backendNodeId: 10 } }),
      "DOM.resolveNode": () => ({ object: { objectId: "el" } }),
      "Runtime.callFunctionOn": (p) => ({ result: p["returnByValue"] ? { value: "x" } : {} }),
    });
    const page = new Page(session);
    const fills = Array.from({ length: 5 }, (_, i) => ({ fill: { target: `#f${i}`, text: "x" } }));
    await act({ page, capture: async () => undefined }, stepsOf(fills), "none");
    expect(graces).toEqual([150, 150, 150, 150, 400]);
  });

  it("is paid by the typing itself when a tick comes between it and a click", async () => {
    const graces: number[] = [];
    const quiet = `(${inpage.domQuiet.toString()})(`;
    let ticked = false;
    const { session } = tab({
      "Page.getFrameTree": () => FRAME,
      "Page.getNavigationHistory": () => HISTORY,
      "Page.createIsolatedWorld": () => ({ executionContextId: 9 }),
      "Runtime.evaluate": (p) => {
        const expression = String(p["expression"]);
        if (!expression.startsWith(quiet)) return { result: { objectId: "el", value: "complete" } };
        graces.push(Number(expression.slice(quiet.length).split(",")[1]));
        return { result: { value: true } };
      },
      "DOM.describeNode": () => ({ node: { backendNodeId: 10 } }),
      "DOM.resolveNode": () => ({ object: { objectId: "el" } }),
      "DOM.getContentQuads": () => ({ quads: [[0, 0, 10, 0, 10, 10, 0, 10]] }),
      "DOM.getNodeForLocation": () => ({ backendNodeId: 10 }),
      "Input.dispatchMouseEvent": (p) => {
        if (p["type"] === "mouseReleased") ticked = true;
        return {};
      },
      "Runtime.callFunctionOn": (p) => {
        if (String(p["functionDeclaration"]) === inpage.checkedOf.toString()) return { result: { value: ticked } };
        return { result: p["returnByValue"] ? { value: "x" } : {} };
      },
    });
    const page = new Page(session);
    await act({ page, capture: async () => undefined }, stepsOf([{ fill: { target: "#q", text: "x" } }, { check: "#box" }, { click: "#go" }]), "none");
    // The fill, then the tick's click, then the click: the floor once, after the typing and so before the click.
    expect(graces).toEqual([400, 150, 150]);
  });
});

describe("a field that will not take the text", () => {
  it("says so without saying what was typed or what it holds", async () => {
    const quiet = `(${inpage.domQuiet.toString()})(`;
    const { session } = tab({
      "Page.getFrameTree": () => FRAME,
      "Page.createIsolatedWorld": () => ({ executionContextId: 9 }),
      "Runtime.evaluate": (p) => (String(p["expression"]).startsWith(quiet) ? { result: { value: true } } : { result: { objectId: "el", value: "complete" } }),
      "DOM.describeNode": () => ({ node: { backendNodeId: 10 } }),
      "DOM.resolveNode": () => ({ object: { objectId: "el" } }),
      "Runtime.callFunctionOn": (p) => {
        const fn = String(p["functionDeclaration"]);
        // A field cut to its maxlength: it holds the start of the password, never all of it.
        if (fn === inpage.valueOf.toString() || fn === inpage.setValue.toString()) return { result: { value: "hunter2-Sec" } };
        return { result: p["returnByValue"] ? { value: null } : {} };
      },
    });
    const page = new Page(session);
    const failed = await page.step({ fill: { target: "#password", text: "hunter2-Secret" } }).then(
      () => undefined,
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    expect(failed).toMatch(/#password would not take the text as typed/);
    expect(failed).not.toContain("hunter2");
  });
});

describe("the outline of a page with a secret field", () => {
  it("hides a field's value by its markup, and one whose markup cannot be read", async () => {
    const nodes = [
      { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Pay" }, childIds: ["2", "3", "4"] },
      { nodeId: "2", parentId: "1", role: { value: "textbox" }, name: { value: "Number" }, value: { value: "4242424242424242" }, backendDOMNodeId: 2 },
      { nodeId: "3", parentId: "1", role: { value: "textbox" }, name: { value: "Note" }, value: { value: "gone" }, backendDOMNodeId: 3 },
      { nodeId: "4", parentId: "1", role: { value: "textbox" }, name: { value: "Email" }, value: { value: "ada@example.com" }, backendDOMNodeId: 4 },
    ];
    const markup: Record<number, string[]> = { 2: ["type", "text", "autocomplete", "cc-number"], 4: ["type", "email", "name", "email"] };
    const { session } = tab({
      "Page.getFrameTree": () => FRAME,
      "Accessibility.getFullAXTree": () => ({ nodes }),
      "DOM.describeNode": (p) => {
        const attributes = markup[Number(p["backendNodeId"])];
        if (!attributes) throw new Error("No node with given id found");
        return { node: { attributes } };
      },
    });
    const { text } = await new Page(session).tree();
    expect(text).toContain('textbox "Number" = "(hidden)"');
    expect(text).toContain('textbox "Note" = "(hidden)"');
    expect(text).toContain('textbox "Email" = "ada@example.com"');
    expect(text).not.toContain("4242");
  });
});

describe("the browser's clock", () => {
  it("dates a request heard late by when the browser sent it, and reads the clock afresh after a sleep", () => {
    const clock = new BrowserClock();
    // Heard 20 ms after the browser sent it, then one heard 500 ms late: dated when it was sent, not when heard.
    expect(clock.date(1_000, 1_020)).toBe(1_020);
    expect(clock.date(2_000, 2_520)).toBe(2_020);
    // The computer sleeps an hour; the clock the browser dates by stands still meanwhile. A request sent on waking is new, not an hour old.
    const woke = 2_520 + 3_600_000;
    expect(clock.date(3_000, woke + 10)).toBe(woke + 10);
    expect(clock.date(3_100, woke + 120)).toBe(woke + 110);
    // Nothing is dated after it was heard, whatever the browser says.
    expect(clock.date(3_300, woke + 200)).toBe(woke + 200);
  });
});

describe("a script of KOS's in a page", () => {
  const tree = (loader: string, origin: string): Record<string, unknown> => ({ frameTree: { frame: { id: "F", loaderId: loader, url: `${origin}/`, securityOrigin: origin } } });
  /** A page whose frames' own contexts are reported when Runtime is turned on, as Chrome does. */
  const scripted = (handlers: Record<string, Handler>, contexts: { frame: string; origin: string }[], options: ConstructorParameters<typeof Page>[1] = {}) => {
    const made: { page?: Page } = {};
    const t = tab({
      ...handlers,
      "Runtime.enable": () => {
        contexts.forEach((c, i) => made.page!.handle({ method: "Runtime.executionContextCreated", params: { context: { id: i + 1, uniqueId: `u${i + 1}`, origin: c.origin, auxData: { isDefault: true, frameId: c.frame } } } }));
        return {};
      },
    });
    const page = new Page(t.session, options);
    made.page = page;
    return { page, calls: t.calls };
  };

  it("runs only in the context checked, on its origin, and marks the document it ran in", async () => {
    const marked: string[] = [];
    const { page, calls } = scripted({ "Page.getFrameTree": () => tree("L1", "https://shop.example"), "Runtime.evaluate": () => ({ result: { type: "string", value: "ok" } }) }, [{ frame: "F", origin: "https://shop.example" }], {
      scripted: { has: () => false, mark: (l) => void marked.push(l) },
    });
    expect(await page.evaluate("1")).toBe("ok");
    const sent = calls.find((c) => c.method === "Runtime.evaluate")!.params;
    expect(sent["uniqueContextId"]).toBe("u1");
    expect(String(sent["expression"]).startsWith('if (self.origin !== "https://shop.example") throw')).toBe(true);
    expect(String(sent["expression"]).endsWith("\n1")).toBe(true);
    expect(calls.map((c) => c.method)).toContain("Runtime.disable");
    expect(marked).toEqual(["L1"]);
  });

  it("withholds the answer when the page loaded another document while it ran, and marks that one too", async () => {
    const marked: string[] = [];
    let trees = 0;
    const { page } = scripted(
      {
        "Page.getFrameTree": () => (++trees === 1 ? tree("L1", "https://elsewhere.example") : tree("L2", "https://bank.example")),
        "Runtime.evaluate": () => ({ result: { type: "string", value: "what the next page held" } }),
      },
      [{ frame: "F", origin: "https://elsewhere.example" }],
      { scripted: { has: () => false, mark: (l) => void marked.push(l) } },
    );
    await expect(page.evaluate("location.href = 'https://bank.example/'; await new Promise((r) => setTimeout(r, 900)); document.body.innerText")).rejects.toThrow(/answer is withheld/);
    expect(marked).toEqual(["L1", "L2"]);
  });

  it("is refused on a site a secret may be filled on, any frame's, an about:blank one by its own context's origin", async () => {
    const blocked = (o: string): string | undefined => (o === "https://bank.example" ? "a saved secret may be filled on this site" : undefined);
    const framed = scripted(
      { "Page.getFrameTree": () => ({ frameTree: { frame: { id: "F", loaderId: "L", securityOrigin: "https://news.example" }, childFrames: [{ frame: { id: "C", loaderId: "M", securityOrigin: "https://bank.example" } }] } }) },
      [{ frame: "F", origin: "https://news.example" }],
      { evalBlocked: blocked },
    );
    await expect(framed.page.evaluate("1")).rejects.toThrow(/refused on https:\/\/bank\.example: a saved secret may be filled on this site, so no script/);
    // A popup opened blank by the bank's page: its frame says no origin, its context says the bank's.
    const blank = scripted({ "Page.getFrameTree": () => tree("L", "://") }, [{ frame: "F", origin: "https://bank.example" }], { evalBlocked: blocked });
    await expect(blank.page.evaluate("localStorage.getItem('kept')")).rejects.toThrow(/refused on https:\/\/bank\.example/);
    for (const { calls } of [framed, blank]) expect(calls.some((c) => c.method === "Runtime.evaluate")).toBe(false);
  });
});

describe("what the agent is told of the page between its calls", () => {
  it("counts a dialog a page raises again and again, and keeps few kinds of them", async () => {
    const { session, calls } = tab({});
    const page = new Page(session, { gate: async () => true });
    for (let i = 0; i < 1000; i++) page.handle({ method: "Page.javascriptDialogOpening", params: { type: "alert", message: "again" } });
    for (let i = 0; i < 100; i++) page.handle({ method: "Page.javascriptDialogOpening", params: { type: "alert", message: `n${i}` } });
    // Every one is answered, as an open one holds the tab.
    expect(calls.filter((c) => c.method === "Page.handleJavaScriptDialog")).toHaveLength(1100);
    // A note of the owner's is kept whatever the page raised.
    await page.run(async () => undefined);
    const notes = page.takeNotes();
    expect(notes.length).toBe(22);
    expect(notes[0]).toBe('A alert dialog said "again", and was closed. (1,000 times)');
    expect(notes).toContain("The owner had this tab and has let go; what is on it may have changed, so look before acting on it.");
    expect(notes.at(-1)).toBe("81 more dialogs were not kept.");
    expect(page.takeNotes()).toEqual([]);
  });
});

describe("where the tab is", () => {
  it("is what the browser's history says, not the page's script, and an error when it says nothing", async () => {
    let said: Record<string, unknown> = HISTORY;
    const { session, calls } = tab({ "Page.getNavigationHistory": () => said });
    const page = new Page(session);
    expect(await page.whereAmI()).toEqual({ url: "https://shop.example/", title: "Shop" });
    expect(calls.some((c) => c.method === "Runtime.evaluate")).toBe(false);
    said = {};
    await expect(page.whereAmI()).rejects.toThrow(/did not say where the tab is/);
  });

  it("goes back or forward only to a page goto would open", async () => {
    const entries = [{ id: 1, url: "file:///Users/owner/notes.txt" }, { id: 2, url: "https://shop.example/" }, { id: 3, url: "chrome://settings/" }];
    const { session, calls } = tab({ "Page.getNavigationHistory": () => ({ currentIndex: 1, entries }) });
    const page = new Page(session);
    await expect(page.step({ go: "back" })).rejects.toThrow(/going back is refused: it is not a web page/);
    await expect(page.step({ go: "forward" })).rejects.toThrow(/going forward is refused/);
    expect(calls.some((c) => c.method === "Page.navigateToHistoryEntry")).toBe(false);
  });
});

describe("a key on a page holding a secret in a frame", () => {
  /** A page whose secret is in frame C's field 10; where the keyboard is, by frame, is `focus`; a frame not in `worlds` has none of KOS's own. */
  const holding = (focus: Record<string, { objectId: string; node: number; frameId?: string } | undefined>, worlds = ["F", "C"]) => {
    const ids = new Map(Object.values(focus).flatMap((f) => (f ? [[f.objectId, f] as const] : [])));
    const { session, calls } = tab({
      "Page.getFrameTree": () => FRAME,
      "Page.createIsolatedWorld": (p) => {
        const frame = String(p["frameId"]);
        if (!worlds.includes(frame)) throw Object.assign(new Error("not passed on"), { code: "method" });
        return { executionContextId: worlds.indexOf(frame) + 1 };
      },
      "Runtime.evaluate": (p) => {
        if (!String(p["expression"]).includes(inpage.focusedHere.toString())) return { result: { value: "complete" } };
        const at = focus[worlds[Number(p["contextId"]) - 1]!];
        return { result: at ? { objectId: at.objectId } : {} };
      },
      "DOM.describeNode": (p) => {
        const at = ids.get(String(p["objectId"]));
        return { node: { backendNodeId: at?.node, ...(at?.frameId ? { frameId: at.frameId } : {}) } };
      },
    });
    const page = new Page(session, { secrets: { taint: { loader: "L", nodes: new Map([[10, "C"]]) }, urls: new Set(), filled: [] } });
    return { page, calls };
  };
  const typed = (calls: { method: string }[]): number => calls.filter((c) => c.method === "Input.dispatchKeyEvent").length;

  it("follows the keyboard down from the main frame: a frame left focused on its field takes no key", async () => {
    const field = { objectId: "field", node: 10 };
    const into = holding({ F: { objectId: "frame", node: 5, frameId: "C" }, C: field });
    await into.page.ready();
    await expect(into.page.step({ press: "x" })).rejects.toThrow(/is refused/);
    await expect(into.page.step({ press: "Backspace" })).rejects.toThrow(/is refused/);
    // The keyboard is on the main page's own field: the frame still says its field is focused, and that is no matter.
    const away = holding({ F: { objectId: "user", node: 7 }, C: field });
    await away.page.ready();
    await away.page.step({ press: "x" });
    await away.page.step({ press: "Meta+c" });
    expect(typed(away.calls)).toBeGreaterThan(0);
  });

  it("refuses only a copy where the keyboard cannot be followed, and lets go of a frame's fields when it goes", async () => {
    const { page, calls } = holding({ F: { objectId: "frame", node: 5, frameId: "C" } }, ["F"]);
    await page.ready();
    await expect(page.step({ press: "Meta+c" })).rejects.toThrow(/is refused/);
    await page.step({ press: "x" });
    expect(typed(calls)).toBeGreaterThan(0);
    // The frame went: the page is held whole, so no copy anywhere, and keys type.
    const gone = holding({ F: { objectId: "user", node: 7 } });
    await gone.page.ready();
    gone.page.handle({ method: "Page.frameDetached", params: { frameId: "C" } });
    await expect(gone.page.step({ press: "Meta+c" })).rejects.toThrow(/is refused/);
    await gone.page.step({ press: "Backspace" });
  });
});
