import type { KosModule, ModuleContext } from "../modules/loader.js";
import type { WatchLook } from "../ops/watches.js";
import { RISKY, SAFE } from "../risk/tiers.js";

/**
 * The browser in fewer steps.
 *
 * The engine offers one tool per gesture, so visiting a page was three
 * model round trips (open, wait, look) and filling a form was one per
 * field. These two tools do a visit, or a run of gestures, inside one
 * call, through the engine's own tools, and hand back the page as it is
 * afterwards. Cheaper in tokens, faster in minutes, and the same tab,
 * the same trust: acting still asks unless the site is trusted.
 */

/** The engine's tools, by the short names used here. */
export const ENGINE_TOOL = {
  url: "agent_browser_get_url",
  open: "agent_browser_open",
  waitForLoad: "agent_browser_wait_for_load",
  waitMs: "agent_browser_wait_ms",
  snapshot: "agent_browser_snapshot",
  read: "agent_browser_read",
  title: "agent_browser_get_title",
  click: "agent_browser_click",
  fill: "agent_browser_fill",
  type: "agent_browser_type",
  press: "agent_browser_press",
  select: "agent_browser_select",
  check: "agent_browser_check",
  uncheck: "agent_browser_uncheck",
  scroll: "agent_browser_scroll",
} as const;

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

export interface BrowserToolsDeps {
  /** Call one of the engine's tools for the current caller, on its own tab. */
  call: (tool: string, args: Record<string, unknown>) => Promise<string>;
  /** A picture of the caller's tab as it is, base64 JPEG, when there is one. */
  look?: () => Promise<{ data: string } | undefined>;
  /** The open tabs, each with whose it is. */
  tabs?: () => TabInfo[];
  /** Move the caller to an open tab; it is the caller's from then on. */
  useTab?: (tab: string) => Promise<void>;
  /** A new tab of the caller's own, which it is then on. Returns its id. */
  newTab?: (url?: string) => Promise<string>;
  /** Read a page in the caller's tab and compare it with the last reading under the same name. */
  watch?: (input: { url: string; name?: string; selector?: string }) => Promise<WatchLook>;
}

type Step =
  | { open: string }
  | { click: string }
  | { fill: { selector: string; text: string } }
  | { type: { selector: string; text: string } }
  | { press: string }
  | { select: { selector: string; values: string[] } }
  | { check: string }
  | { uncheck: string }
  | { scroll: "up" | "down" }
  | { wait: number };

const STEP_KEYS = ["open", "click", "fill", "type", "press", "select", "check", "uncheck", "scroll", "wait"] as const;

/** One step, checked: exactly one known key with the right shape of value. */
export function parseStep(raw: unknown, at: number): Step {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`step ${at + 1}: must be an object with one of ${STEP_KEYS.join(", ")}`);
  const keys = Object.keys(raw as object);
  const key = keys.find((k) => (STEP_KEYS as readonly string[]).includes(k));
  if (!key || keys.length !== 1) throw new Error(`step ${at + 1}: must have exactly one of ${STEP_KEYS.join(", ")}`);
  const value = (raw as Record<string, unknown>)[key];
  const str = (what: string): string => {
    if (typeof value !== "string" || !value.trim()) throw new Error(`step ${at + 1}: ${key} wants ${what}`);
    return value;
  };
  const pair = (second: "text"): { selector: string; text: string } => {
    const v = value as Record<string, unknown> | null;
    if (!v || typeof v !== "object" || typeof v["selector"] !== "string" || typeof v[second] !== "string") {
      throw new Error(`step ${at + 1}: ${key} wants {selector, ${second}}`);
    }
    return { selector: v["selector"], text: v[second] as string };
  };
  switch (key) {
    case "open":
      return { open: str("a url") };
    case "click":
      return { click: str("a selector or @ref") };
    case "fill":
      return { fill: pair("text") };
    case "type":
      return { type: pair("text") };
    case "press":
      return { press: str("a key name") };
    case "select": {
      const v = value as Record<string, unknown> | null;
      const values = v && Array.isArray(v["values"]) ? (v["values"] as unknown[]).filter((x): x is string => typeof x === "string") : typeof v?.["value"] === "string" ? [v["value"] as string] : [];
      if (!v || typeof v["selector"] !== "string" || values.length === 0) throw new Error(`step ${at + 1}: select wants {selector, values}`);
      return { select: { selector: v["selector"], values } };
    }
    case "check":
      return { check: str("a selector or @ref") };
    case "uncheck":
      return { uncheck: str("a selector or @ref") };
    case "scroll":
      if (value !== "up" && value !== "down") throw new Error(`step ${at + 1}: scroll wants "up" or "down"`);
      return { scroll: value };
    case "wait": {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 30_000) throw new Error(`step ${at + 1}: wait wants milliseconds, up to 30000`);
      return { wait: value };
    }
    default:
      throw new Error(`step ${at + 1}: unknown step`);
  }
}

/** A step as one engine call. */
export function stepCall(step: Step): { tool: string; args: Record<string, unknown>; said: string } {
  if ("open" in step) return { tool: ENGINE_TOOL.open, args: { url: step.open }, said: `opened ${step.open}` };
  if ("click" in step) return { tool: ENGINE_TOOL.click, args: { selector: step.click }, said: `clicked ${step.click}` };
  if ("fill" in step) return { tool: ENGINE_TOOL.fill, args: { selector: step.fill.selector, text: step.fill.text }, said: `filled ${step.fill.selector}` };
  if ("type" in step) return { tool: ENGINE_TOOL.type, args: { selector: step.type.selector, text: step.type.text }, said: `typed into ${step.type.selector}` };
  if ("press" in step) return { tool: ENGINE_TOOL.press, args: { key: step.press }, said: `pressed ${step.press}` };
  if ("select" in step) return { tool: ENGINE_TOOL.select, args: { selector: step.select.selector, values: step.select.values }, said: `selected ${step.select.values.join(", ")} in ${step.select.selector}` };
  if ("check" in step) return { tool: ENGINE_TOOL.check, args: { selector: step.check }, said: `checked ${step.check}` };
  if ("uncheck" in step) return { tool: ENGINE_TOOL.uncheck, args: { selector: step.uncheck }, said: `unchecked ${step.uncheck}` };
  if ("scroll" in step) return { tool: ENGINE_TOOL.scroll, args: { direction: step.scroll }, said: `scrolled ${step.scroll}` };
  return { tool: ENGINE_TOOL.waitMs, args: { ms: step.wait }, said: `waited ${step.wait}ms` };
}

/** How the page is handed back after a visit or a run of steps. */
type Then = "snapshot" | "read" | "none";

function thenOf(input: Record<string, unknown>, fallback: Then): Then {
  const v = input["then"];
  return v === "snapshot" || v === "read" || v === "none" ? v : fallback;
}

async function pageAfter(deps: BrowserToolsDeps, then: Then, scope?: string): Promise<string> {
  if (then === "none") return "";
  if (then === "read") return deps.call(ENGINE_TOOL.read, {});
  const title = await deps.call(ENGINE_TOOL.title, {}).catch(() => "");
  const snapshot = await deps.call(ENGINE_TOOL.snapshot, { interactive: true, compact: true, ...(scope ? { selector: scope } : {}) });
  return `${title ? `Title: ${title.trim()}\n` : ""}${snapshot}`;
}

export function createBrowserModule(deps: BrowserToolsDeps): KosModule {
  return {
    manifest: {
      name: "browser",
      version: "1.0.0",
      provides: [
        { kind: "tool", name: "browser.visit", version: "1.0.0" },
        { kind: "tool", name: "browser.act", version: "1.0.0" },
        { kind: "tool", name: "browser.handoff", version: "1.0.0" },
        { kind: "tool", name: "browser.look", version: "1.0.0" },
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
            "Open a page in your browser tab and get what is on it, in one call: the title and an accessibility snapshot of the " +
            "interactive elements with @refs you can act on. Use this instead of open + wait + snapshot. `then: \"read\"` returns " +
            "the page as readable text instead (for articles); `scope` limits the snapshot to a CSS selector.",
          inputSchema: {
            type: "object",
            properties: {
              url: { type: "string" },
              then: { type: "string", enum: ["snapshot", "read", "none"] },
              scope: { type: "string", description: "CSS selector to limit the snapshot to" },
            },
            required: ["url"],
          },
        },
        async (input) => {
          const url = typeof input["url"] === "string" ? input["url"].trim() : "";
          if (!url) throw new Error("url required");
          await deps.call(ENGINE_TOOL.open, { url });
          await deps.call(ENGINE_TOOL.waitForLoad, {}).catch(() => undefined);
          const page = await pageAfter(deps, thenOf(input, "snapshot"), typeof input["scope"] === "string" ? input["scope"] : undefined);
          return `Opened ${url}\n${page}`.trim();
        },
        SAFE,
      );

      ctx.registerTool(
        {
          name: "browser.act",
          description:
            "Do several things on the current page in one call, in order, then get the page as it is afterwards. Each step is " +
            "one of {open: url}, {click: selector}, {fill: {selector, text}}, {type: {selector, text}}, {press: key}, " +
            "{select: {selector, values}}, {check: selector}, {uncheck: selector}, {scroll: \"up\"|\"down\"}, {wait: ms}. " +
            "Selectors are @refs from the last snapshot or CSS. Use this for a form or a short sequence instead of one call per gesture. " +
            "`then` is \"snapshot\" (default), \"read\" or \"none\".",
          inputSchema: {
            type: "object",
            properties: {
              steps: { type: "array", items: { type: "object" }, minItems: 1, maxItems: 20 },
              then: { type: "string", enum: ["snapshot", "read", "none"] },
            },
            required: ["steps"],
          },
        },
        async (input) => {
          const raw = Array.isArray(input["steps"]) ? input["steps"] : [];
          if (raw.length === 0) throw new Error("steps required");
          if (raw.length > 20) throw new Error("at most 20 steps in one call");
          const steps = raw.map((s, i) => parseStep(s, i));
          const done: string[] = [];
          for (const step of steps) {
            const call = stepCall(step);
            try {
              await deps.call(call.tool, call.args);
            } catch (err) {
              const why = err instanceof Error ? err.message : String(err);
              throw new Error(`${done.length ? `Done: ${done.join("; ")}. ` : ""}Step ${done.length + 1} failed (${call.said.split(" ")[0]}): ${why}`);
            }
            done.push(call.said);
          }
          const page = await pageAfter(deps, thenOf(input, "snapshot"));
          return `Done: ${done.join("; ")}.\n${page}`.trim();
        },
        RISKY,
      );

      /*
       * Eyes. The snapshot says what is on the page; a picture says how it
       * looks, which is the question when a snapshot is ambiguous, a layout
       * matters, or a chart is the answer. Costly in tokens, so on request.
       */
      ctx.registerTool(
        {
          name: "browser.look",
          description:
            "See your tab as a picture, as it is right now. Use when the snapshot leaves you unsure what the page looks like " +
            "(a layout, a chart, an image, a visual check); otherwise the snapshot is cheaper.",
          inputSchema: { type: "object", properties: {} },
        },
        async () => {
          const shot = deps.look ? await deps.look() : undefined;
          if (!shot) throw new Error("no tab to look at; open a page first");
          return { text: "The tab as it is now.", images: [{ mediaType: "image/jpeg", data: shot.data }] };
        },
        SAFE,
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
          const url = await deps.call(ENGINE_TOOL.url, {}).catch(() => "");
          const title = await deps.call(ENGINE_TOOL.title, {}).catch(() => "");
          return `The owner has done it. The tab is now at ${url.trim() || "the same page"}${title.trim() ? ` (${title.trim()})` : ""}. Look again before you act.`;
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
            .map((t) => `${t.id}${t.current ? " (yours, current)" : t.mine ? " (yours)" : t.owner ? ` (${t.owner}'s)` : " (the owner's)"}: ${t.title.trim() || "untitled"} — ${t.url}`)
            .join("\n");
        },
        SAFE,
      );

      ctx.registerTool(
        {
          name: "browser.use_tab",
          description:
            "Work in a tab that is already open: one the owner pointed at with @tab:, or one from browser.tabs. It becomes " +
            "your tab, and you get the page as it is. `then` as for browser.visit.",
          inputSchema: {
            type: "object",
            properties: { tab: { type: "string", description: "the tab's id" }, then: { type: "string", enum: ["snapshot", "read", "none"] } },
            required: ["tab"],
          },
        },
        async (input) => {
          const tab = typeof input["tab"] === "string" ? input["tab"].trim() : "";
          if (!tab) throw new Error("tab required");
          if (!deps.useTab) throw new Error("no browser to switch tabs in");
          await deps.useTab(tab);
          const page = await pageAfter(deps, thenOf(input, "snapshot"));
          return `Now on tab ${tab}.\n${page}`.trim();
        },
        SAFE,
      );

      ctx.registerTool(
        {
          name: "browser.new_tab",
          description:
            "Open a new tab of your own, at a url if given, and work in it from now on; your other tabs stay open and you can " +
            "go back to one with browser.use_tab. `then` as for browser.visit.",
          inputSchema: {
            type: "object",
            properties: { url: { type: "string" }, then: { type: "string", enum: ["snapshot", "read", "none"] } },
          },
        },
        async (input) => {
          if (!deps.newTab) throw new Error("no browser to open a tab in");
          const url = typeof input["url"] === "string" && input["url"].trim() ? input["url"].trim() : undefined;
          const id = await deps.newTab(url);
          if (url) await deps.call(ENGINE_TOOL.waitForLoad, {}).catch(() => undefined);
          const page = url ? await pageAfter(deps, thenOf(input, "snapshot")) : "";
          return `Opened tab ${id}${url ? ` at ${url}` : ""}.\n${page}`.trim();
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
            "a scheduled job can be the single action {tool: \"browser.watch\", args: {url, tell: true}} and need no model.",
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
          const url = typeof input["url"] === "string" ? input["url"].trim() : "";
          if (!url) throw new Error("url required");
          if (!deps.watch) throw new Error("no browser to watch with");
          const name = typeof input["name"] === "string" && input["name"].trim() ? input["name"].trim() : undefined;
          const selector = typeof input["selector"] === "string" && input["selector"].trim() ? input["selector"].trim() : undefined;
          const look = await deps.watch({ url, ...(name ? { name } : {}), ...(selector ? { selector } : {}) });
          const when = new Date(look.changedAt).toISOString();
          if (look.first) return `First look at ${look.key}: kept for next time.`;
          if (!look.changed) return `No change at ${look.key} since ${when}.`;
          const said = `Changed: ${look.key}\n${look.url}\n${look.diff ?? ""}`.trim();
          if (input["tell"] === true) await ctx.services?.notify?.({ text: said, target: { kind: "owner" } });
          return said;
        },
        SAFE,
      );
    },
  };
}
