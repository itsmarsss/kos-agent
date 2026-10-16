import type { KosModule, ModuleContext } from "../modules/loader.js";
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

export interface BrowserToolsDeps {
  /** Call one of the engine's tools for the current caller, on its own tab. */
  call: (tool: string, args: Record<string, unknown>) => Promise<string>;
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
    },
  };
}
