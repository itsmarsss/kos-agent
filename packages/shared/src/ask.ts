/**
 * An approval as every card draws it: what KOS wants to do, where, the
 * steps it takes, why it asks, and what a remembered yes would keep. The
 * dashboard reads it from an ask's arguments; the host sends it whole to
 * KOS for Chrome, KOS for Mac and KOS for iPhone, which cannot.
 */

import { actionSteps, summarizeAction, type ActionNames, type StepLine } from "./format-action.js";
import type { KeyPlatform } from "./keys.js";

/** What a yes-and-remember keeps: the tool or its family, the scope it covers, the project it holds in. */
export interface AskRule {
  tool: string;
  scope: string | null;
  project?: string | null;
}

/** Where an ask would act, in words, and the site it is on when it is on one (for its icon). */
export interface AskPlace {
  words: string;
  site?: string;
}

/** An ask, as a card lays it out. */
export interface AskView {
  /** What KOS wants to do, its ids named: the card's title. */
  title: string;
  /** Where: "In your Chrome on docs.google.com". */
  place?: AskPlace;
  /** Each action it takes, for a run of actions, keys as caps. */
  steps?: StepLine[];
  /** Why it asks, as a phrase: "Clicks, types or fills on the page". */
  risk?: string;
  /** The remembered yes's button, when the ask can be remembered: "Always allow on docs.google.com". */
  always?: string;
  /** What that yes keeps, exactly, and where to take it back. */
  alwaysTip?: string;
}

export interface AskInput {
  tool: string;
  args: string | Record<string, unknown>;
  reason?: string | null;
  rule?: AskRule | null;
  /** A browser ask in the owner's own Chrome, not KOS's. */
  yours?: boolean;
  names?: ActionNames;
  /** Whose keyboard a browser's keys are said for. */
  platform?: KeyPlatform;
}

const upperFirst = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

function argsOf(args: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof args !== "string") return args;
  try {
    const v = JSON.parse(args) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A rule's scope split at its first colon: "your-chrome:docs.google.com" is that kind and that site. */
function scopeParts(scope: string | null | undefined): [kind: string, what: string] | undefined {
  if (!scope) return undefined;
  const at = scope.indexOf(":");
  return at === -1 ? [scope, ""] : [scope.slice(0, at), scope.slice(at + 1)];
}

function hostOf(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

function folderOf(path: unknown): string {
  if (typeof path !== "string") return "";
  const i = path.replace(/\/+$/, "").lastIndexOf("/");
  return i <= 0 ? "" : path.slice(0, i);
}

/**
 * Where an ask would act: which browser and on what site, the Mac, a
 * folder, a host on the web, a connected server. Nothing for a tool that
 * acts in KOS itself.
 */
export function askPlace(input: Pick<AskInput, "tool" | "args" | "rule" | "yours">): AskPlace | undefined {
  const { tool, rule, yours } = input;
  const a = argsOf(input.args);
  if (tool.startsWith("browser.")) {
    const scope = scopeParts(rule?.scope);
    const site = scope && (scope[0] === "your-chrome" || scope[0] === "site") ? scope[1] : hostOf(a.url);
    const browser = yours || scope?.[0] === "your-chrome" ? "In your Chrome" : "In KOS's browser";
    return site ? { words: `${browser} on ${site}`, site } : { words: browser };
  }
  if (tool.startsWith("chrome.")) return { words: "In your Chrome" };
  if (tool.startsWith("computer.")) return { words: "On your Mac" };
  if (tool === "shell.run" || tool === "python.run") {
    const cwd = typeof a.cwd === "string" && a.cwd.trim() ? a.cwd.trim() : "";
    return { words: cwd ? `In ${cwd}` : "In the workspace" };
  }
  if (tool.startsWith("files.")) {
    const folder = folderOf(a.path ?? a.from);
    return { words: folder ? `In ${folder}` : "In the workspace" };
  }
  if (tool === "http.fetch") {
    const site = hostOf(a.url);
    return site ? { words: `On ${site}`, site } : undefined;
  }
  const mcp = /^mcp\.([^.]+)\./.exec(tool);
  if (mcp) return { words: `Through ${mcp[1]}` };
  return undefined;
}

/**
 * Why an ask asks, as a phrase to lead with a capital: the rule's own
 * words, less what the place already says ("on docs.google.com", "in your
 * Chrome"). Nothing when all it says is that the tool is risky.
 */
export function askRisk(reason: string | null | undefined): string | undefined {
  const said = (reason ?? "")
    .replace(/,?\s*in your Chrome$/i, "")
    .replace(/^on \S+$/i, "")
    .replace(/^risky tool$/i, "")
    .trim();
  return said ? upperFirst(said) : undefined;
}

/** What a remembered yes covers, as its button says it: the site, the folder, the host, the program. */
export function alwaysWords(scope: string | null): string {
  const parts = scopeParts(scope);
  if (!parts) return "Always allow";
  const [kind, what] = parts;
  switch (kind) {
    case "your-chrome":
    case "site":
      return `Always allow on ${what}`;
    case "dir":
      return what ? `Always allow in ${what}` : "Always allow in the workspace";
    case "host":
      return `Always allow for ${what}`;
    case "cmd":
      return `Always allow ${what}`;
    case "table":
      return `Always allow on ${what}`;
    default:
      return "Always allow here";
  }
}

/** Where a remembered yes is taken back. */
const UNDO = "Undo it in Settings, Permissions.";

/**
 * What a remembered yes keeps, exactly: which calls stop asking, where, and
 * where to take it back. Said on the button's tooltip.
 */
export function alwaysTip(rule: AskRule): string {
  const parts = scopeParts(rule.scope);
  const project = rule.project ? ` in the project ${rule.project}` : "";
  const family = rule.tool.endsWith(".*") ? rule.tool.slice(0, -2) : undefined;
  const calls = family ? `${family} actions` : rule.tool;
  let keeps: string;
  if (!parts) keeps = `${calls} stops asking${project}, whatever it is given.`;
  else {
    const [kind, what] = parts;
    switch (kind) {
      case "your-chrome":
        keeps = `clicking, typing and going to pages on ${what} in your Chrome stop asking${project}. Running script in the page still asks.`;
        break;
      case "site":
        keeps = `clicking, typing and going to pages on ${what} in KOS's browser stop asking${project}. Running script in the page still asks.`;
        break;
      case "dir":
        keeps = `${calls} in ${what || "the workspace"} and the folders under it stops asking${project}.`;
        break;
      case "host":
        keeps = `${calls} to ${what} stops asking${project}.`;
        break;
      case "cmd":
        keeps = `running ${what} on its own stops asking${project}. A chain or a pipe still asks.`;
        break;
      case "table":
        keeps = `${calls} on the table ${what} stops asking${project}.`;
        break;
      default:
        keeps = `${calls} to the same place stops asking${project}.`;
    }
  }
  return `Approves this, and from now on ${keeps} ${UNDO}`;
}

/** An ask, as every card lays it out. */
export function askView(input: AskInput): AskView {
  const { tool, args, reason, rule, names, platform } = input;
  const place = askPlace(input);
  const risk = askRisk(reason);
  const lines = actionSteps(tool, args, platform);
  // A run of actions with no purpose said is titled by what it acts on and
  // listed in full; one action alone is its own title.
  const intent = argsOf(args).intent;
  const said = typeof intent === "string" && intent.trim() !== "";
  const steps = lines && (said || lines.length > 1) ? lines : undefined;
  const title = steps && !said ? (tool === "computer.act" ? "Use your Mac" : "Act on the page") : summarizeAction(tool, args, names, platform);
  return {
    title,
    ...(place ? { place } : {}),
    ...(steps ? { steps } : {}),
    ...(risk ? { risk } : {}),
    ...(rule ? { always: alwaysWords(rule.scope), alwaysTip: alwaysTip(rule) } : {}),
  };
}
