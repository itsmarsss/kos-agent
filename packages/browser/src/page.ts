import type { CdpEvent } from "./cdp.js";
import * as inpage from "./inpage.js";
import { parseKeys, type KeyPress } from "./keys.js";
import { indexOf, Refs, treeOf, type AxNode, type PageIndex } from "./snapshot.js";
import type { Step } from "./steps.js";

/**
 * One tab's hands.
 *
 * Everything an agent does to a page goes through here, over Chrome's own
 * protocol on the tab's session: no daemon in between to lose a reply. Every
 * wait has a deadline and ends in an answer, so a slow page is reported as
 * still loading rather than as a failure, and nothing waits on a page
 * forever. A dialog is answered the moment it opens, since an open alert
 * holds every later command on the tab; what it said is told to the agent.
 * Clicks and keys are real input events, aimed at the middle of the element
 * after it is scrolled into view, and a click that would land on something
 * else (a cookie banner over the button) is refused, naming what is in the
 * way.
 */

/** A tab's commands, already addressed to it. */
export interface Session {
  send(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
}

/** How long a page may take to be ready to read, and to load in full. */
export interface PageLimits {
  domMs: number;
  loadMs: number;
}

const LIMITS: PageLimits = { domMs: 20_000, loadMs: 30_000 };

export interface PageOptions {
  now?: () => number;
  limits?: Partial<PageLimits>;
  /**
   * Waited on before each call and each step: while the owner has taken the
   * tab, the agent's hands wait for them to let go. True when it waited, so
   * the agent is told the page may have changed under it.
   */
  gate?: () => Promise<boolean>;
}
/** After an action: how long a navigation it started may take, and the network's quiet. */
const SETTLE_NAV_MS = 10_000;
const QUIET_MS = 350;
const QUIET_MAX_MS = 2_500;
/** A request open longer than this is a stream or a long poll, and does not hold the quiet. */
const LONG_REQUEST_MS = 4_000;
/** Request kinds that never finish the way a page load does. */
const ENDLESS = new Set(["WebSocket", "EventSource", "Media", "Ping", "Prefetch"]);
const EVAL_MS = 10_000;
/** Moves between a drag's press and its release, as a hand would make them. */
const DRAG_STEPS = 8;
const AX_MS = 20_000;
const INPUT_MS = 10_000;
/** How long a wait for text or an element may take. */
const WAIT_FOR_MS = 15_000;
/** How much of a page's text, or of a script's answer, is handed back. */
const READ_MAX = 24_000;
/** Embedded frames read into a look, at most. */
const FRAMES_MAX = 8;
/** Objects made for one call, released after it. */
const GROUP = "kos-hands";

type CallArg = { value: unknown } | { objectId: string };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function exceptionText(details: unknown): string {
  const d = details as { exception?: { description?: string; value?: unknown }; text?: string } | undefined;
  const first = d?.exception?.description?.split("\n")[0];
  return first ?? (d?.exception?.value !== undefined ? String(d.exception.value) : (d?.text ?? "an error"));
}

interface FrameInfo {
  id: string;
  url: string;
}

function childFrames(tree: unknown): FrameInfo[] {
  const out: FrameInfo[] = [];
  const visit = (node: unknown): void => {
    const n = node as { frame?: { id?: string; url?: string }; childFrames?: unknown[] } | undefined;
    for (const child of n?.childFrames ?? []) {
      const c = child as { frame?: { id?: string; url?: string } };
      if (c.frame?.id) out.push({ id: c.frame.id, url: c.frame.url ?? "" });
      visit(child);
    }
  };
  visit(tree);
  return out;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

export interface Look {
  index: PageIndex;
  /** Embedded frames that could not be read, by host. */
  unread: string[];
}

export class Page {
  private readonly refs = new Refs();
  /** The document the refs belong to. */
  private documentId = "";
  private mainFrame = "";
  /** The main frame's current document, and the lifecycle points it has reached. */
  private life = { loader: "", reached: new Set<string>() };
  private loading = false;
  private readonly inflight = new Map<string, number>();
  /** How to answer the next dialog, when a step said. */
  private answer: { accept: boolean; text?: string } | null = null;
  /** What a drag the page started would carry, while a drag of the hands' is under way. */
  private dragged: unknown;
  private readonly heard: string[] = [];
  private crashed = false;
  private prepared: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly wakers = new Set<() => void>();

  private readonly limits: PageLimits;
  private readonly now: () => number;
  private readonly gate: () => Promise<boolean>;

  constructor(
    private readonly session: Session,
    options: PageOptions = {},
  ) {
    this.limits = { ...LIMITS, ...options.limits };
    this.now = options.now ?? Date.now;
    this.gate = options.gate ?? (async () => false);
  }

  /** Calls on one tab, one at a time: two at once would act on each other's page. */
  run<T>(work: () => Promise<T>): Promise<T> {
    const gated = async (): Promise<T> => {
      await this.waitForOwner();
      return work();
    };
    const next = this.queue.then(gated, gated);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** While the owner has the tab, nothing; once they let go, a word that the page may have changed. */
  private async waitForOwner(): Promise<void> {
    if (await this.gate()) this.heard.push("The owner had this tab and has let go; what is on it may have changed, so look before acting on it.");
  }

  /** An event from the tab's session. */
  handle(event: CdpEvent): void {
    const p = event.params;
    switch (event.method) {
      case "Page.frameStartedLoading":
        if (p["frameId"] === this.mainFrame) this.loading = true;
        break;
      case "Page.frameStoppedLoading":
        if (p["frameId"] === this.mainFrame) this.loading = false;
        break;
      case "Page.lifecycleEvent":
        if (p["frameId"] === this.mainFrame) {
          const loader = String(p["loaderId"] ?? "");
          if (loader !== this.life.loader) this.life = { loader, reached: new Set() };
          this.life.reached.add(String(p["name"] ?? ""));
        }
        break;
      case "Page.frameNavigated": {
        const frame = p["frame"] as { id?: string; parentId?: string } | undefined;
        if (frame?.id && !frame.parentId) this.mainFrame = frame.id;
        break;
      }
      case "Page.javascriptDialogOpening":
        this.onDialog(String(p["type"] ?? "alert"), String(p["message"] ?? ""));
        break;
      // The page began a drag of its own: what it would carry, for the drop.
      case "Input.dragIntercepted":
        this.dragged = p["data"];
        break;
      case "Network.requestWillBeSent":
        if (!ENDLESS.has(String(p["type"] ?? ""))) this.inflight.set(String(p["requestId"]), this.now());
        break;
      case "Network.loadingFinished":
      case "Network.loadingFailed":
        this.inflight.delete(String(p["requestId"]));
        break;
      case "Inspector.targetCrashed":
        this.crashed = true;
        break;
      default:
        return;
    }
    for (const wake of [...this.wakers]) wake();
  }

  /** What happened on the page that the agent should hear: dialogs answered, a crash recovered. */
  takeNotes(): string[] {
    return this.heard.splice(0);
  }

  /** The tab ready to be driven, and well: a crashed page is loaded again. */
  async ready(): Promise<void> {
    this.prepared ??= this.prepare().catch((err: unknown) => {
      this.prepared = null;
      throw err;
    });
    await this.prepared;
    if (this.crashed) {
      this.crashed = false;
      await this.session.send("Page.reload", {});
      await this.settle(this.life.loader);
      this.heard.push("The tab had crashed, and was loaded again.");
    }
  }

  private async prepare(): Promise<void> {
    await this.session.send("Page.enable");
    await this.session.send("Page.setLifecycleEventsEnabled", { enabled: true });
    await this.session.send("Network.enable");
    await this.session.send("Inspector.enable").catch(() => undefined);
    const tree = await this.session.send("Page.getFrameTree");
    const frame = (tree["frameTree"] as { frame?: { id?: string; loaderId?: string } } | undefined)?.frame;
    this.mainFrame = frame?.id ?? "";
    // A page already there when KOS came to it: what it has reached is asked, not heard.
    const state = await this.value<string>("document.readyState").catch(() => "complete");
    const reached = state === "complete" ? ["DOMContentLoaded", "load"] : state === "interactive" ? ["DOMContentLoaded"] : [];
    this.life = { loader: frame?.loaderId ?? "", reached: new Set(reached) };
    this.documentId = this.life.loader;
  }

  // Going places.

  /**
   * To a url, until the page can be read (or has loaded in full). A page
   * still loading at the deadline is handed back as it is, said to be so.
   */
  async goto(url: string, until: "dom" | "load" = "dom"): Promise<{ stillLoading: boolean }> {
    let answer: Record<string, unknown>;
    try {
      answer = await this.session.send("Page.navigate", { url }, this.limits.domMs);
    } catch (err) {
      if (err instanceof Error && err.message.endsWith("timed out")) return { stillLoading: true };
      throw err;
    }
    const error = typeof answer["errorText"] === "string" ? answer["errorText"] : "";
    if (error === "net::ERR_ABORTED") throw new Error(`${url} did not open as a page; if it is a file, it downloaded, and lands in Files`);
    if (error) throw new Error(`could not open ${url}: ${error}`);
    const loader = typeof answer["loaderId"] === "string" ? answer["loaderId"] : "";
    // No new document: the url only moved within the page.
    if (!loader) return { stillLoading: false };
    const want = until === "load" ? "load" : "DOMContentLoaded";
    const reached = await this.waitUntil(() => this.life.loader === loader && this.life.reached.has(want), until === "load" ? this.limits.loadMs : this.limits.domMs);
    if (reached) await this.quiet();
    return { stillLoading: !reached };
  }

  /** Back, forward or reload, as the browser's buttons do. False when there is no page to go to. */
  async go(where: "back" | "forward" | "reload"): Promise<boolean> {
    const before = this.life.loader;
    if (where === "reload") {
      await this.session.send("Page.reload", {});
    } else {
      const history = await this.session.send("Page.getNavigationHistory");
      const entries = (history["entries"] as { id: number }[] | undefined) ?? [];
      const at = typeof history["currentIndex"] === "number" ? history["currentIndex"] : -1;
      const entry = entries[at + (where === "back" ? -1 : 1)];
      if (!entry) return false;
      await this.session.send("Page.navigateToHistoryEntry", { entryId: entry.id });
    }
    await this.settle(before);
    return true;
  }

  // Seeing.

  /** Where the tab is and what the page is called. */
  async whereAmI(): Promise<{ url: string; title: string }> {
    return this.value<{ url: string; title: string }>(`(${inpage.whereAmI.toString()})()`, 3_000).catch(() => ({ url: "", title: "" }));
  }

  /** What can be acted on, each with its ref; `scope` limits it to the part of the page a CSS selector names. */
  async index(scope?: string): Promise<Look> {
    const { nodes, unread } = await this.nodes(scope);
    return { index: indexOf(nodes, this.refs), unread };
  }

  /** The whole page as an outline, each element with its ref. */
  async tree(scope?: string): Promise<{ text: string; cut: boolean; unread: string[] }> {
    const { nodes, unread } = await this.nodes(scope);
    return { ...treeOf(nodes, this.refs), unread };
  }

  /** The page's words, or the words of what a selector names, with the links among them. */
  async read(selector?: string): Promise<string> {
    const got = await this.value<{ text: string; links: { text: string; href: string }[]; matched: number } | null>(
      `(${inpage.readPage.toString()})(${JSON.stringify(selector ?? null)})`,
    );
    if (!got) throw new Error(selector ? `nothing on the page matches ${selector}` : "the page has nothing to read");
    const text = got.text.length > READ_MAX ? `${got.text.slice(0, READ_MAX)}\n(cut at ${READ_MAX} characters; a selector reads one part)` : got.text;
    const links = got.links.length ? `\n\nLinks:\n${got.links.map((l) => `- ${l.text}: ${l.href}`).join("\n")}` : "";
    const many = selector && got.matched > 1 ? `(${got.matched} elements match ${selector})\n` : "";
    return `${many}${text || "(no text)"}${links}`;
  }

  /** A script run in the page, top-level await allowed; its answer as text. */
  async evaluate(code: string): Promise<string> {
    const answer = await this.session.send(
      "Runtime.evaluate",
      { expression: code, replMode: true, awaitPromise: true, returnByValue: true, userGesture: true, timeout: EVAL_MS, objectGroup: GROUP },
      EVAL_MS + 2_000,
    );
    if (answer["exceptionDetails"]) throw new Error(`the script threw: ${exceptionText(answer["exceptionDetails"])}`);
    const result = answer["result"] as { type?: string; value?: unknown; description?: string } | undefined;
    if (!result || result.type === "undefined") return "undefined";
    const out = typeof result.value === "string" ? result.value : result.value !== undefined ? JSON.stringify(result.value, null, 2) : (result.description ?? "");
    return out.length > READ_MAX ? `${out.slice(0, READ_MAX)}\n(cut at ${READ_MAX} characters)` : out;
  }

  // Acting.

  /** One step on the page; what was done, in words. */
  async step(step: Step): Promise<string> {
    await this.waitForOwner();
    if ("open" in step) {
      const went = await this.goto(step.open);
      return `opened ${step.open}${went.stillLoading ? " (still loading)" : ""}`;
    }
    if ("go" in step) return (await this.go(step.go)) ? `went ${step.go}` : `there was nowhere to go ${step.go}`;
    if ("click" in step) {
      await this.acting(async () => this.click(await this.element(step.click), step.click));
      return `clicked ${step.click}`;
    }
    if ("dblclick" in step) {
      await this.acting(async () => this.click(await this.element(step.dblclick), step.dblclick, { button: "left", count: 2 }));
      return `double-clicked ${step.dblclick}`;
    }
    if ("rightclick" in step) {
      await this.acting(async () => this.click(await this.element(step.rightclick), step.rightclick, { button: "right", count: 1 }));
      return `right-clicked ${step.rightclick}`;
    }
    if ("drag" in step) {
      const { from, to } = step.drag;
      await this.acting(async () => this.drag(await this.element(from), from, await this.element(to), to));
      return `dragged ${from} to ${to}`;
    }
    if ("hover" in step) {
      const at = await this.point(await this.element(step.hover), step.hover);
      await this.mouse("mouseMoved", at);
      await sleep(150);
      return `hovered over ${step.hover}`;
    }
    if ("fill" in step) {
      await this.acting(async () => this.write(await this.element(step.fill.target), step.fill.target, step.fill.text, true));
      return `filled ${step.fill.target}`;
    }
    if ("type" in step) {
      await this.acting(async () => this.write(await this.element(step.type.target), step.type.target, step.type.text, false));
      return `typed into ${step.type.target}`;
    }
    if ("press" in step) {
      const press = parseKeys(step.press);
      await this.acting(() => this.key(press));
      return `pressed ${step.press}`;
    }
    if ("select" in step) {
      const picked = await this.choose(await this.element(step.select.target), step.select.target, step.select.values);
      return `picked ${picked.join(", ")} in ${step.select.target}`;
    }
    if ("check" in step || "uncheck" in step) {
      const want = "check" in step;
      const target = "check" in step ? step.check : step.uncheck;
      return this.toggle(await this.element(target), target, want);
    }
    if ("scroll" in step) return this.scroll(step.scroll);
    if ("wait" in step) return this.wait(step.wait);
    this.answer = step.dialog;
    return `will ${step.dialog.accept ? "accept" : "dismiss"} the next dialog`;
  }

  /** Objects made for the last call let go of, so a long session does not hold the page's memory. */
  async release(): Promise<void> {
    await this.session.send("Runtime.releaseObjectGroup", { objectGroup: GROUP }).catch(() => undefined);
  }

  /** An action, then the page given time to answer it: a navigation it started, and the network's quiet. */
  private async acting(action: () => Promise<void>): Promise<void> {
    const before = this.life.loader;
    await action();
    await this.settle(before);
  }

  private async settle(before: string): Promise<void> {
    await sleep(100);
    if (this.loading || this.life.loader !== before) {
      await this.waitUntil(() => (this.life.loader !== before ? this.life.reached.has("DOMContentLoaded") : !this.loading), SETTLE_NAV_MS);
    }
    await this.quiet();
  }

  /** Until no request has been open for a moment, or the most that is worth waiting. */
  private async quiet(): Promise<void> {
    const end = this.now() + QUIET_MAX_MS;
    let calm = this.now();
    while (this.now() < end) {
      const t = this.now();
      let busy = false;
      for (const [id, at] of this.inflight) {
        if (t - at > 60_000) this.inflight.delete(id);
        else if (t - at < LONG_REQUEST_MS) busy = true;
      }
      if (busy) calm = t;
      else if (t - calm >= QUIET_MS) return;
      await sleep(50);
    }
  }

  private async click(node: number, label: string, how: { button: "left" | "right"; count: number } = { button: "left", count: 1 }): Promise<void> {
    const at = await this.reachable(node, label);
    await this.mouse("mouseMoved", at);
    for (let n = 1; n <= how.count; n++) {
      await this.mouse("mousePressed", at, { button: how.button, clickCount: n });
      await this.mouse("mouseReleased", at, { button: how.button, clickCount: n });
    }
  }

  /**
   * Press on one element, move to another and let go: a slider, a card into
   * a column, a file onto a drop zone. A page that uses the browser's own
   * drag and drop gets it from the drag Chrome would have started, which
   * synthetic pointer moves alone never start.
   */
  private async drag(fromNode: number, from: string, toNode: number, to: string): Promise<void> {
    const a = await this.reachable(fromNode, from);
    const b = await this.point(toNode, to);
    this.dragged = undefined;
    await this.session.send("Input.setInterceptDrags", { enabled: true }).catch(() => undefined);
    try {
      await this.mouse("mouseMoved", a);
      await this.mouse("mousePressed", a, { button: "left", buttons: 1, clickCount: 1 });
      for (let i = 1; i <= DRAG_STEPS; i++) {
        const t = i / DRAG_STEPS;
        await this.mouse("mouseMoved", { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, { button: "left", buttons: 1 });
        await sleep(16);
      }
      if (this.dragged) {
        for (const type of ["dragEnter", "dragOver", "drop"]) await this.session.send("Input.dispatchDragEvent", { type, x: b.x, y: b.y, data: this.dragged, modifiers: 0 }, INPUT_MS);
      }
      await this.mouse("mouseReleased", b, { button: "left", clickCount: 1 });
    } finally {
      this.dragged = undefined;
      await this.session.send("Input.setInterceptDrags", { enabled: false }).catch(() => undefined);
    }
  }

  /** Text into a field: in place of what is there, or after it. A field that ignores typing is set directly. */
  private async write(node: number, label: string, text: string, replace: boolean): Promise<void> {
    const field = (await this.nodeVia(node, inpage.editableOf)) ?? node;
    await this.session.send("DOM.focus", { backendNodeId: field }).catch(() => this.click(field, label));
    await this.call(field, replace ? inpage.selectAll : inpage.caretToEnd);
    if (text) await this.session.send("Input.insertText", { text }, INPUT_MS);
    else if (replace) await this.key(parseKeys("Backspace"));
    if (!replace) return;
    const now = await this.call<string | null>(field, inpage.valueOf);
    if (now === null || now === text) return;
    const set = await this.call<string>(field, inpage.setValue, [{ value: text }]).catch((err: unknown) => {
      throw new Error(`${label} would not take the text: ${err instanceof Error ? err.message : String(err)}`);
    });
    if (set !== text) throw new Error(`${label} would not take the text; it holds ${JSON.stringify(set.slice(0, 60))}`);
  }

  private async choose(node: number, label: string, values: string[]): Promise<string[]> {
    const got = await this.call<{ picked?: string[]; error?: string; options?: string[] }>(node, inpage.selectOptions, [{ value: values }]);
    if (got.error === "not-select") throw new Error(`${label} is not a list box (<select>); click it, then click the option`);
    if (!got.picked?.length) throw new Error(`${label} has no option ${values.map((v) => JSON.stringify(v)).join(" or ")}; it has ${(got.options ?? []).join(", ")}`);
    await this.settle(this.life.loader);
    return got.picked;
  }

  private async toggle(node: number, label: string, want: boolean): Promise<string> {
    const before = await this.call<boolean | null>(node, inpage.checkedOf);
    if (before === want) return `${label} was already ${want ? "checked" : "unchecked"}`;
    await this.acting(() => this.click(node, label));
    const after = await this.call<boolean | null>(node, inpage.checkedOf).catch(() => null);
    if (after !== null && after !== want) throw new Error(`clicking ${label} did not ${want ? "check" : "uncheck"} it`);
    return `${want ? "checked" : "unchecked"} ${label}`;
  }

  private async scroll(where: string): Promise<string> {
    if (where === "up" || where === "down") {
      const view = await this.viewport();
      await this.mouse("mouseWheel", { x: view.width / 2, y: view.height / 2 }, { deltaX: 0, deltaY: (where === "down" ? 1 : -1) * Math.round(view.height * 0.8) });
      await sleep(250);
      return `scrolled ${where}`;
    }
    const node = await this.element(where);
    await this.session.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: node });
    return `scrolled to ${where}`;
  }

  private async wait(what: Extract<Step, { wait: unknown }>["wait"]): Promise<string> {
    if (typeof what === "number") {
      await sleep(what);
      return `waited ${what}ms`;
    }
    const [kind, value] = "text" in what ? (["text", what.text] as const) : "selector" in what ? (["selector", what.selector] as const) : (["gone", what.gone] as const);
    const check = `(${inpage.present.toString()})(${JSON.stringify(kind)}, ${JSON.stringify(value)})`;
    const end = this.now() + WAIT_FOR_MS;
    while (this.now() < end) {
      if (await this.value<boolean>(check, 3_000).catch(() => false)) return kind === "gone" ? `"${value}" went` : `"${value}" appeared`;
      await sleep(200);
    }
    throw new Error(`waited ${WAIT_FOR_MS / 1000}s and ${JSON.stringify(value)} ${kind === "gone" ? "is still there" : "never appeared"}`);
  }

  // The parts.

  /** The element a target names: a ref from the last look, a text selector, or the first match of a CSS selector. */
  private async element(target: string): Promise<number> {
    const ref = /^@?(e\d+)$/.exec(target);
    if (ref) {
      const node = this.refs.nodeOf(ref[1]!);
      if (node === undefined) throw new Error(`there is no @${ref[1]} on this page; refs come from the last look, and a new page has new ones`);
      return node;
    }
    const byText = textSelector(target);
    const expression = byText ? `(${inpage.byText.toString()})(${JSON.stringify(byText.base)}, ${JSON.stringify(byText.text)})` : `document.querySelector(${JSON.stringify(target)})`;
    const found = await this.session.send("Runtime.evaluate", { expression, objectGroup: GROUP }, EVAL_MS);
    if (found["exceptionDetails"]) throw new Error(`${target} is not a selector I can use: ${exceptionText(found["exceptionDetails"])}`);
    const objectId = (found["result"] as { objectId?: string } | undefined)?.objectId;
    if (!objectId) throw new Error(`nothing on the page matches ${target}`);
    return this.backendOf(objectId);
  }

  private async backendOf(objectId: string): Promise<number> {
    const described = await this.session.send("DOM.describeNode", { objectId });
    const node = (described["node"] as { backendNodeId?: number } | undefined)?.backendNodeId;
    if (node === undefined) throw new Error("the element has no node");
    return node;
  }

  private async objectOf(node: number): Promise<string> {
    const resolved = await this.session.send("DOM.resolveNode", { backendNodeId: node, objectGroup: GROUP }).catch(() => undefined);
    const objectId = (resolved?.["object"] as { objectId?: string } | undefined)?.objectId;
    if (!objectId) throw new Error("that element is gone from the page (it changed); take a fresh look");
    return objectId;
  }

  /** A page-side function run on an element, its answer by value. */
  private async call<T>(node: number, fn: (this: Element, ...args: never[]) => unknown, args: CallArg[] = []): Promise<T> {
    const objectId = await this.objectOf(node);
    const answer = await this.session.send(
      "Runtime.callFunctionOn",
      { objectId, functionDeclaration: fn.toString(), arguments: args, returnByValue: true, awaitPromise: true },
      EVAL_MS,
    );
    if (answer["exceptionDetails"]) throw new Error(exceptionText(answer["exceptionDetails"]));
    return (answer["result"] as { value?: T } | undefined)?.value as T;
  }

  /** A page-side function run on an element that answers with another element, or with none. */
  private async nodeVia(node: number, fn: (this: Element) => Element | null): Promise<number | undefined> {
    const objectId = await this.objectOf(node);
    const answer = await this.session.send("Runtime.callFunctionOn", { objectId, functionDeclaration: fn.toString(), objectGroup: GROUP }, EVAL_MS);
    const other = (answer["result"] as { objectId?: string } | undefined)?.objectId;
    return other ? this.backendOf(other) : undefined;
  }

  /** An expression in the page, its answer by value. */
  private async value<T>(expression: string, timeoutMs = EVAL_MS): Promise<T> {
    const answer = await this.session.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (answer["exceptionDetails"]) throw new Error(exceptionText(answer["exceptionDetails"]));
    return (answer["result"] as { value?: T } | undefined)?.value as T;
  }

  /** The middle of an element, scrolled into view; for a control hidden behind its label, the label's. */
  private async point(node: number, label: string, viaLabel = false): Promise<{ x: number; y: number }> {
    await this.session.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: node }).catch(() => undefined);
    const got = await this.session.send("DOM.getContentQuads", { backendNodeId: node }).catch(() => ({}) as Record<string, unknown>);
    const quad = ((got["quads"] as number[][] | undefined) ?? []).find((q) => Math.abs((q[4]! - q[0]!) * (q[5]! - q[1]!)) > 1);
    if (quad) return { x: (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4, y: (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4 };
    if (!viaLabel) {
      const drawnBy = await this.nodeVia(node, inpage.labelOf).catch(() => undefined);
      if (drawnBy !== undefined && drawnBy !== node) return this.point(drawnBy, label, true);
    }
    throw new Error(`${label} is not visible on the page (hidden, or inside something closed); open what holds it first`);
  }

  /**
   * Where a press on the element lands on it. Its middle, as the hands find
   * it; when something sits over that (most often a bar the page keeps at an
   * edge, over whatever was just scrolled to that edge), the element brought
   * to the middle of the view; failing that, another part of it that is
   * clear. Only an element covered everywhere is refused, naming what is in
   * the way, since then the page is waiting on that first.
   */
  private async reachable(node: number, label: string): Promise<{ x: number; y: number }> {
    const at = await this.point(node, label);
    const first = await this.blocker(node, at);
    if (first === undefined) return at;
    await this.call(node, inpage.centre).catch(() => undefined);
    const centred = await this.point(node, label);
    if ((await this.blocker(node, centred)) === undefined) return centred;
    for (const spot of await this.spots(node)) if ((await this.blocker(node, spot)) === undefined) return spot;
    const what = await this.call<string>(first, inpage.describe).catch(() => "something");
    throw new Error(`${label} is covered by ${what} @${this.refs.refOf(first)}; close or answer that first`);
  }

  /**
   * What a press at a point would land on instead of the element, if
   * anything. Hit as a real press is: through anything the pointer passes
   * through, such as the border KOS draws on a tab of the owner's Chrome,
   * which covers the whole page.
   */
  private async blocker(node: number, at: { x: number; y: number }): Promise<number | undefined> {
    const hit = await this.session
      .send("DOM.getNodeForLocation", { x: Math.round(at.x), y: Math.round(at.y), includeUserAgentShadowDOM: false, ignorePointerEventsNone: false })
      .catch(() => undefined);
    const top = hit?.["backendNodeId"] as number | undefined;
    if (top === undefined || top === node) return undefined;
    const reached = await this.call<boolean>(node, inpage.reaches, [{ objectId: await this.objectOf(top) }]).catch(() => true);
    return reached ? undefined : top;
  }

  /** Other places on an element to press, inside its edges: its quarters, then near its corners. */
  private async spots(node: number): Promise<{ x: number; y: number }[]> {
    const got = await this.session.send("DOM.getContentQuads", { backendNodeId: node }).catch(() => ({}) as Record<string, unknown>);
    const quad = ((got["quads"] as number[][] | undefined) ?? [])[0];
    if (!quad) return [];
    const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
    const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
    const [left, right, top, bottom] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const at = (fx: number, fy: number): { x: number; y: number } => ({ x: left + (right - left) * fx, y: top + (bottom - top) * fy });
    return [at(0.25, 0.5), at(0.75, 0.5), at(0.5, 0.25), at(0.5, 0.75), at(0.1, 0.15), at(0.9, 0.15), at(0.1, 0.85), at(0.9, 0.85)];
  }

  private async mouse(type: string, at: { x: number; y: number }, extra: Record<string, unknown> = {}): Promise<void> {
    await this.session.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "none", modifiers: 0, ...extra }, INPUT_MS);
  }

  private async key(press: KeyPress): Promise<void> {
    let bits = 0;
    for (const held of press.held) {
      bits |= held.bit;
      await this.session.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: held.key, code: held.code, windowsVirtualKeyCode: held.keyCode, modifiers: bits }, INPUT_MS);
    }
    const base = { key: press.key, code: press.code, windowsVirtualKeyCode: press.keyCode, nativeVirtualKeyCode: press.keyCode, modifiers: press.modifiers };
    await this.session.send(
      "Input.dispatchKeyEvent",
      {
        ...base,
        type: press.text ? "keyDown" : "rawKeyDown",
        ...(press.text ? { text: press.text, unmodifiedText: press.text } : {}),
        ...(press.commands ? { commands: press.commands } : {}),
      },
      INPUT_MS,
    );
    await this.session.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" }, INPUT_MS);
    for (const held of [...press.held].reverse()) {
      bits &= ~held.bit;
      await this.session.send("Input.dispatchKeyEvent", { type: "keyUp", key: held.key, code: held.code, windowsVirtualKeyCode: held.keyCode, modifiers: bits }, INPUT_MS);
    }
  }

  private async viewport(): Promise<{ width: number; height: number }> {
    const metrics = await this.session.send("Page.getLayoutMetrics");
    const view = (metrics["cssVisualViewport"] ?? metrics["layoutViewport"] ?? {}) as { clientWidth?: number; clientHeight?: number };
    return { width: view.clientWidth ?? 1280, height: view.clientHeight ?? 800 };
  }

  /** The tree of the page and of the frames in it that live in its process, as one. */
  private async nodes(scope?: string): Promise<{ nodes: AxNode[]; unread: string[] }> {
    // A new document: its elements are new, and so are their refs.
    if (this.life.loader && this.life.loader !== this.documentId) {
      this.refs.clear();
      this.documentId = this.life.loader;
    }
    const nodes = ((await this.session.send("Accessibility.getFullAXTree", {}, AX_MS))["nodes"] as AxNode[] | undefined) ?? [];
    const unread: string[] = [];
    const frames = childFrames((await this.session.send("Page.getFrameTree"))["frameTree"]).slice(0, FRAMES_MAX);
    for (const [i, frame] of frames.entries()) {
      try {
        const owner = (await this.session.send("DOM.getFrameOwner", { frameId: frame.id }))["backendNodeId"];
        const host = nodes.find((n) => n.backendDOMNodeId === owner);
        const inner = ((await this.session.send("Accessibility.getFullAXTree", { frameId: frame.id }, AX_MS))["nodes"] as AxNode[] | undefined) ?? [];
        const root = inner.find((n) => !n.parentId);
        if (!host || !root) continue;
        const tag = `f${i}:`;
        for (const n of inner) {
          n.nodeId = tag + n.nodeId;
          if (n.parentId) n.parentId = tag + n.parentId;
          if (n.childIds) n.childIds = n.childIds.map((c) => tag + c);
        }
        root.parentId = host.nodeId;
        host.childIds = [...(host.childIds ?? []), root.nodeId];
        nodes.push(...inner);
      } catch {
        if (frame.url && !frame.url.startsWith("about:")) unread.push(hostOf(frame.url));
      }
    }
    if (!scope) return { nodes, unread };
    const within = await this.scopeNodes(scope);
    return { nodes: nodes.filter((n) => n.backendDOMNodeId !== undefined && within.has(n.backendDOMNodeId)), unread };
  }

  /** Every node inside what a selector names, through shadow roots and frames. */
  private async scopeNodes(scope: string): Promise<Set<number>> {
    const found = await this.session.send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(scope)})`, objectGroup: GROUP }, EVAL_MS);
    if (found["exceptionDetails"]) throw new Error(`${scope} is not a selector I can use: ${exceptionText(found["exceptionDetails"])}`);
    const objectId = (found["result"] as { objectId?: string } | undefined)?.objectId;
    if (!objectId) throw new Error(`nothing on the page matches ${scope}`);
    const described = await this.session.send("DOM.describeNode", { objectId, depth: -1, pierce: true });
    const out = new Set<number>();
    const visit = (n: unknown): void => {
      const node = n as { backendNodeId?: number; children?: unknown[]; shadowRoots?: unknown[]; contentDocument?: unknown } | undefined;
      if (!node) return;
      if (node.backendNodeId !== undefined) out.add(node.backendNodeId);
      for (const c of node.children ?? []) visit(c);
      for (const c of node.shadowRoots ?? []) visit(c);
      visit(node.contentDocument);
    };
    visit(described["node"]);
    return out;
  }

  private onDialog(type: string, message: string): void {
    const chosen = this.answer ?? { accept: type === "alert" || type === "beforeunload" };
    this.answer = null;
    void this.session
      .send("Page.handleJavaScriptDialog", { accept: chosen.accept, ...(chosen.text !== undefined ? { promptText: chosen.text } : {}) })
      .catch(() => undefined);
    const said = message ? ` said ${JSON.stringify(message.length > 200 ? `${message.slice(0, 199)}…` : message)}` : " opened";
    const how = type === "alert" ? "was closed" : chosen.accept ? "was accepted" : `was dismissed; {dialog: "accept"} before the step that opens it accepts it`;
    this.heard.push(`A ${type === "beforeunload" ? "leave-this-page" : type} dialog${said}, and ${how}.`);
  }

  private waitUntil(ok: () => boolean, ms: number): Promise<boolean> {
    if (ok()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (v: boolean): void => {
        clearTimeout(timer);
        this.wakers.delete(check);
        resolve(v);
      };
      const check = (): void => {
        if (ok()) done(true);
      };
      const timer = setTimeout(() => done(false), ms);
      this.wakers.add(check);
    });
  }
}

/**
 * A selector by the words on the thing, as Playwright spells one and a model
 * writes one: `button:has-text('Submit')`, or `text=Submit` for anything.
 */
export function textSelector(target: string): { base: string; text: string } | undefined {
  const plain = /^text=(["']?)(.+)\1$/.exec(target.trim());
  if (plain) return { base: "", text: plain[2]! };
  const has = /^(.*):has-text\((["'])(.+)\2\)$/.exec(target.trim());
  return has ? { base: has[1]!.trim(), text: has[3]! } : undefined;
}
