import { STEPS_MAX, VISIT_MAX, act, evaluate, look, stepsOf, touchesPage, urlFor, visit, type Seen, type Tab, type Then } from "@kos/browser";

import type { KosModule, ModuleContext } from "../modules/loader.js";
import type { WatchLook } from "../ops/watches.js";
import { RISKY, SAFE } from "../risk/tiers.js";

/**
 * The browser, as tools.
 *
 * Few of them, each doing a whole thing: a visit opens a page and looks; a
 * run of steps acts and looks; every one hands back the page as it is after,
 * a picture with a short index of what can be acted on, so the next call can
 * be the right one without a call in between to find out. The hands are
 * @kos/browser's; this is what the model is told, and how much each costs in
 * trust: looking is free, acting asks unless the site is trusted, and a
 * script in the page asks every time.
 */

/** A tab as the caller is told of it. */
export interface TabInfo {
  id: string;
  title: string;
  url: string;
  /** Another agent's, in words; absent for the caller's own and the owner's. */
  owner?: string;
  /** The caller's own. */
  mine?: boolean;
  /** The one the caller is on. */
  current?: boolean;
}

/**
 * A browser other than KOS's own that a conversation may be working in: the
 * owner's Chrome, through the KOS extension. While a conversation is, its
 * browser tools work there, on the tabs that browser gives it.
 */
export interface BrowserElsewhere {
  /** Whether the conversation is working in it now. */
  active(conversationId: string): boolean;
  /** The conversation's tab there, opened when it has none. */
  tab(conversationId: string): Promise<Tab>;
  tabs(conversationId: string): TabInfo[];
  tabsOf(conversationId: string): string[];
  useTab(conversationId: string, tab: string): Promise<void>;
  newTab(conversationId: string): Promise<string>;
  /** The host of the conversation's tab there, for its site's trust. */
  siteOf(conversationId: string): string | undefined;
  /** A picture of the conversation's tab there, if it has one. */
  picture(conversationId: string, maxWidth: number): Promise<string | undefined>;
}

export interface BrowserToolsDeps {
  /** The caller's own tab, made the first time it browses. */
  tab: () => Promise<Tab>;
  /** The open tabs, each with whose it is. */
  tabs?: () => TabInfo[];
  /** The ids of the caller's tabs, so a tab a step opened can be named. */
  mine?: () => string[];
  /** Move the caller to an open tab; it is the caller's from then on. */
  useTab?: (tab: string) => Promise<void>;
  /** A new tab of the caller's own, which it is then on. Returns its id. */
  newTab?: () => Promise<string>;
  /** Read a page in the caller's tab and compare it with the last reading under the same name. */
  watch?: (input: { url: string; name?: string; selector?: string }) => Promise<WatchLook>;
}

const THEN = { type: "string", enum: ["look", "snapshot", "read", "none"] };

function thenOf(input: Record<string, unknown>, fallback: Then): Then {
  const v = input["then"];
  return v === "look" || v === "snapshot" || v === "read" || v === "none" ? v : fallback;
}

function str(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** The urls a visit was given: `url`, or `urls` for several in one call. */
function urlsOf(input: Record<string, unknown>): string[] {
  const many = Array.isArray(input["urls"]) ? input["urls"].filter((u): u is string => typeof u === "string" && u.trim() !== "").map((u) => u.trim()) : [];
  const one = str(input, "url");
  return [...(one ? [one] : []), ...many.filter((u) => u !== one)];
}

function answer(seen: Seen): string | Seen {
  return seen.images.length ? seen : seen.text;
}

export function createBrowserModule(deps: BrowserToolsDeps): KosModule {
  return {
    manifest: {
      name: "browser",
      version: "2.0.0",
      provides: [
        { kind: "tool", name: "browser.visit", version: "2.0.0" },
        { kind: "tool", name: "browser.act", version: "2.0.0" },
        { kind: "tool", name: "browser.look", version: "2.0.0" },
        { kind: "tool", name: "browser.eval", version: "1.0.0" },
        { kind: "tool", name: "browser.handoff", version: "1.0.0" },
        { kind: "tool", name: "browser.tabs", version: "1.0.0" },
        { kind: "tool", name: "browser.use_tab", version: "1.0.0" },
        { kind: "tool", name: "browser.new_tab", version: "1.0.0" },
        { kind: "tool", name: "browser.watch", version: "1.0.0" },
      ],
    },
    async activate(ctx: ModuleContext) {
      ctx.registerTool(
        {
          name: "browser.visit",
          description:
            "Open a page in your browser tab and see it, in one call: a picture of the tab, the title and url, and an index of " +
            "what can be acted on, one line each with its @ref (a dialog's controls first). Read the page from the picture; act " +
            `with browser.act using the refs, which stay the same while the page does. \`urls\` visits up to ${VISIT_MAX} pages in one ` +
            'call. `then: "read"` returns the page as text with its links (for articles); `then: "snapshot"` the whole page as an ' +
            "outline; `scope` limits either to what a CSS selector names. A page still loading after 20 seconds is handed back " +
            'as it is, said to be still loading; `wait: "load"` waits for every resource first. Only http and https pages open.',
          inputSchema: {
            type: "object",
            properties: {
              url: { type: "string" },
              urls: { type: "array", items: { type: "string" }, description: `several pages in one call, at most ${VISIT_MAX}` },
              then: THEN,
              scope: { type: "string", description: "CSS selector to limit what is handed back to" },
              wait: { type: "string", enum: ["dom", "load"], description: "dom (default): the page can be read; load: every resource has loaded" },
            },
          },
        },
        async (input) => {
          const scope = str(input, "scope");
          return answer(await visit(await deps.tab(), urlsOf(input), { then: thenOf(input, "look"), ...(scope ? { scope } : {}), until: input["wait"] === "load" ? "load" : "dom" }));
        },
        SAFE,
      );

      ctx.registerTool(
        {
          name: "browser.act",
          description:
            "Do several things on the current page in one call, in order, then see the page as it is afterwards. Each step is one " +
            "of {click: target}, {fill: {target, text}} (replaces what is there), {type: {target, text}} (adds to it), " +
            '{press: "Enter" | "Meta+a" | ...}, {select: {target, values}}, {check: target}, {uncheck: target}, {hover: target}, ' +
            '{scroll: "up" | "down" | target}, {open: url}, {go: "back" | "forward" | "reload"}, {wait: ms | {text} | {selector} | {gone: text}}, ' +
            '{dialog: "accept" | "dismiss"} (how to answer the next dialog; by default an alert is closed and a confirm dismissed). ' +
            "A target is a @ref from the last look, or a CSS selector. Each step waits for the page to settle after it. A click " +
            "that would land on something else (a banner over the button) is refused, naming what is in the way. Steps that only " +
            "look or move (open, go, hover, scroll, wait, dialog) run at once; the rest ask the owner unless the site is trusted. " +
            "If a step fails, the run stops and says what was done, why, and what the page offers now. `then` as for browser.visit.",
          inputSchema: {
            type: "object",
            properties: {
              steps: { type: "array", items: { type: "object" }, minItems: 1, maxItems: STEPS_MAX },
              then: THEN,
            },
            required: ["steps"],
          },
        },
        async (input) => {
          const steps = stepsOf(input["steps"]);
          const tab = await deps.tab();
          const before = new Set(deps.mine?.() ?? []);
          const seen = await act(tab, steps, thenOf(input, "look"));
          const opened = (deps.mine?.() ?? []).filter((t) => !before.has(t));
          const note = opened.length ? `\nIt opened ${opened.length === 1 ? `a tab, ${opened[0]}` : `tabs ${opened.join(", ")}`}; browser.use_tab works there.` : "";
          return answer({ ...seen, text: `${seen.text}${note}` });
        },
        // Asks only when a step touches the page. A watcher that waits four
        // seconds for a table to render was asking the owner every six hours.
        { floor: "safe", escalate: (input) => (touchesPage(input) ? "clicks, types or fills on the page" : false) },
      );

      ctx.registerTool(
        {
          name: "browser.look",
          description:
            "See your tab as it is now, without doing anything to it: the picture and the index of what can be acted on, as " +
            'browser.visit gives. `then: "snapshot"` for the whole outline instead, `then: "read"` for its text; `scope` narrows either.',
          inputSchema: { type: "object", properties: { then: THEN, scope: { type: "string" } } },
        },
        async (input) => answer(await look(await deps.tab(), thenOf(input, "look"), str(input, "scope"))),
        SAFE,
      );

      /*
       * A script in the page can do anything the page can, as the owner,
       * on whatever site the tab is on. Never trusted by site: it asks
       * every time.
       */
      ctx.registerTool(
        {
          name: "browser.eval",
          description:
            "Run JavaScript in your tab's page and get its answer back as text (JSON for objects); top-level await works. For what " +
            "the steps cannot do: reading a value a page keeps in a script, calling the page's own API. It asks the owner every time.",
          inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
        },
        async (input) => {
          const code = str(input, "code");
          if (!code) throw new Error("code required");
          return evaluate(await deps.tab(), code);
        },
        RISKY,
      );

      /*
       * The owner's hands. A login, a captcha, a payment, a consent: things
       * an agent must not do itself. The ask is queued like any risky call,
       * so the turn waits on the owner's answer; "approved" means the owner
       * has done it in the window, and the handler runs then, handing the
       * agent the page as they left it. Never remembered: each ask is its
       * own.
       */
      ctx.registerTool(
        {
          name: "browser.handoff",
          description:
            "Hand this tab to the owner for something you must not do yourself: a login, a two-factor code, a captcha, a payment, " +
            "a consent. Say plainly what you need them to do. Your turn waits until they say they are done, then continues with " +
            "the page as they left it; take a fresh look before acting on it. If they decline, say so and stop.",
          inputSchema: {
            type: "object",
            properties: { reason: { type: "string", description: "what you need the owner to do, in one line" } },
            required: ["reason"],
          },
        },
        async () => {
          const where = await (await deps.tab()).page.whereAmI();
          return `The owner has done it. The tab is now at ${where.url || "the same page"}${where.title ? ` (${where.title})` : ""}. Look again before you act.`;
        },
        RISKY,
      );

      /*
       * Tabs. The owner points at a tab with @tab: (theirs, or another
       * agent's), and an agent may want a second page open beside the first.
       * A tab is one agent's at a time; using one takes it.
       */
      ctx.registerTool(
        {
          name: "browser.tabs",
          description:
            "The browser's open tabs: id, title, url and whose each is. Yours is marked. The owner's own tabs have no owner. " +
            "Use browser.use_tab to work in one.",
          inputSchema: { type: "object", properties: {} },
        },
        async () => {
          const tabs = deps.tabs?.() ?? [];
          if (tabs.length === 0) return "No tabs are open.";
          return tabs
            .map((t) => `${t.id}${t.current ? " (yours, current)" : t.mine ? " (yours)" : t.owner ? ` (${t.owner}'s)` : " (the owner's)"}: ${t.title.trim() || "untitled"}: ${t.url}`)
            .join("\n");
        },
        SAFE,
      );

      ctx.registerTool(
        {
          name: "browser.use_tab",
          description:
            "Work in a tab that is already open: one the owner pointed at with @tab:, one a step opened, or one from browser.tabs. " +
            "It becomes your tab, and you see the page as it is. `then` as for browser.visit.",
          inputSchema: {
            type: "object",
            properties: { tab: { type: "string", description: "the tab's id" }, then: THEN },
            required: ["tab"],
          },
        },
        async (input) => {
          const tab = str(input, "tab");
          if (!tab) throw new Error("tab required");
          if (!deps.useTab) throw new Error("no browser to switch tabs in");
          await deps.useTab(tab);
          const seen = await look(await deps.tab(), thenOf(input, "look"));
          return answer({ ...seen, text: `Now on tab ${tab}.\n${seen.text}`.trim() });
        },
        SAFE,
      );

      ctx.registerTool(
        {
          name: "browser.new_tab",
          description:
            "Open a new tab of your own, at a url if given, and work in it from now on; your other tabs stay open and you can " +
            "go back to one with browser.use_tab. `then` as for browser.visit.",
          inputSchema: { type: "object", properties: { url: { type: "string" }, then: THEN } },
        },
        async (input) => {
          if (!deps.newTab) throw new Error("no browser to open a tab in");
          const raw = str(input, "url");
          // Checked before the tab is made, so a refused address leaves nothing behind.
          const url = raw ? urlFor(raw) : undefined;
          const id = await deps.newTab();
          if (!url) return `Opened tab ${id}; it is blank, and yours.`;
          const seen = await visit(await deps.tab(), [url], { then: thenOf(input, "look") });
          return answer({ ...seen, text: `Opened tab ${id}.\n${seen.text}`.trim() });
        },
        SAFE,
      );

      /*
       * A page watched for change. Read now and compared with last time
       * under its name; the difference is the answer. With `tell`, a change
       * goes to the owner from here, so a scheduled watch is a plain actions
       * job with no model turn in it.
       */
      ctx.registerTool(
        {
          name: "browser.watch",
          description:
            "Watch a page for change: open the url in your tab, read it, and compare with what was read last time under the same " +
            "name (the url when no name is given). Says it is the first look, that nothing changed since when, or which lines went " +
            "and came. `selector` limits the reading to one part of the page. With `tell: true` a change is sent to the owner, so " +
            'a scheduled job can be the single action {tool: "browser.watch", args: {url, tell: true}} and need no model.',
          inputSchema: {
            type: "object",
            properties: {
              url: { type: "string" },
              name: { type: "string", description: "what to call this watch; the url by default" },
              selector: { type: "string", description: "CSS selector for the part of the page to read" },
              tell: { type: "boolean", description: "send a change to the owner" },
            },
            required: ["url"],
          },
        },
        async (input) => {
          const url = str(input, "url");
          if (!url) throw new Error("url required");
          if (!deps.watch) throw new Error("no browser to watch with");
          const name = str(input, "name");
          const selector = str(input, "selector");
          const seen = await deps.watch({ url, ...(name ? { name } : {}), ...(selector ? { selector } : {}) });
          const when = new Date(seen.changedAt).toISOString();
          if (seen.first) return `First look at ${seen.key}: kept for next time.`;
          if (!seen.changed) return `No change at ${seen.key} since ${when}.`;
          const said = `Changed: ${seen.key}\n${seen.url}\n${seen.diff ?? ""}`.trim();
          if (input["tell"] === true) await ctx.services?.notify?.({ text: said, target: { kind: "owner" } });
          return said;
        },
        SAFE,
      );
    },
  };
}
