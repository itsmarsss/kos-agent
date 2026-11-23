/**
 * An approval as every card draws it: what KOS wants to do, where, the
 * steps it takes, why it asks, and what a remembered yes would keep. The
 * dashboard reads it from an ask's arguments; the host sends it whole to
 * KOS for Chrome, KOS for Mac and KOS for iPhone, which cannot.
 */

import { actionSteps, summarizeAction, type ActionHome, type ActionNames, type StepLine } from "./format-action.js";
import { placePath } from "./filehome.js";
import { showInvisible } from "./invisible.js";
import { usesSecret } from "./secretref.js";
import { PRIVATE_TOOLS, type AskSecret } from "./secrets.js";
import type { KeyPlatform } from "./keys.js";

/** What a yes-and-remember keeps: the tool or its family, the scope it covers, the project it holds in. */
export interface AskRule {
  tool: string;
  scope: string | null;
  project?: string | null;
}

/** Where an ask would act, in words. */
export interface AskPlace {
  words: string;
}

/** An ask, as a card lays it out. */
export interface AskView {
  /** What the call does, its ids named: one action, or what a run of them acts on. The card's title. */
  title: string;
  /** What the model said the step is for, in its own words: shown as KOS's, smaller than what the step does. */
  said?: string;
  /** Where: "In your Chrome on docs.google.com". */
  place?: string;
  /** Each action it takes, for a run of actions, keys as caps. */
  steps?: StepLine[];
  /** Why it asks, as a phrase: "Clicks, types or fills on the page". */
  risk?: string;
  /** The remembered yes's button, when the ask can be remembered: "Always allow on docs.google.com". */
  always?: string;
  /** What that yes keeps, exactly, and where to take it back. */
  alwaysTip?: string;
  /** Why there is no remembered yes, when the ask could otherwise have one: "Secrets always ask". */
  alwaysNote?: string;
  /** The secret a secrets tool would place, and where: drawn as its own block on the card. */
  secret?: AskSecret;
  /**
   * Set by the host on a device's copy of an ask too big to send whole: its
   * arguments and steps are left out, so the card offers no Approve and
   * sends the owner to the dashboard.
   */
  tooLong?: boolean;
}

export interface AskInput {
  tool: string;
  args: string | Record<string, unknown>;
  reason?: string | null;
  rule?: AskRule | null;
  /** A browser ask in the owner's own Chrome, not KOS's. */
  yours?: boolean;
  /** It always asks (it places a secret): no remembered yes, whatever its rule. Read from the tool and its arguments when not said. */
  asksAlways?: boolean;
  /** The secret block a secrets tool's ask carries: its "always" is a grant on the origin, offered where the secret's policy says so. */
  secret?: AskSecret | null;
  /** Asked though the chat is in Auto, for what Auto never covers: no remembered yes, and the card says why. */
  beyondAuto?: boolean;
  names?: ActionNames;
  /** Where the asking turn's paths start, so a file tool's title names the path it really reaches. */
  where?: ActionHome;
  /** Whose keyboard a browser's keys are said for. */
  platform?: KeyPlatform;
}

/** The owner's clipboard read on their Mac, the one approval card that shows part of what the call would bring in. */
export const CLIPBOARD_READ = "clipboard.read";
/** As much of the clipboard as its card quotes. */
export const CLIPBOARD_PREVIEW_MAX = 120;

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
export function askPlace(input: Pick<AskInput, "tool" | "args" | "rule" | "yours" | "where">): AskPlace | undefined {
  const { tool, rule, yours } = input;
  const a = argsOf(input.args);
  if (tool.startsWith("browser.")) {
    const scope = scopeParts(rule?.scope);
    const site = scope && (scope[0] === "your-chrome" || scope[0] === "site") ? scope[1] : hostOf(a.url);
    const browser = yours || scope?.[0] === "your-chrome" ? "In your Chrome" : "In KOS's browser";
    return { words: site ? `${browser} on ${site}` : browser };
  }
  if (tool.startsWith("chrome.")) return { words: "In your Chrome" };
  if (tool.startsWith("computer.")) return { words: "On your Mac" };
  if (tool === "secrets.type" || tool === CLIPBOARD_READ) return { words: typeof a.device === "string" && a.device ? `On your Mac, ${a.device}` : "On your Mac" };
  if (tool === "shell.run" || tool === "python.run") {
    const cwd = typeof a.cwd === "string" && a.cwd.trim() ? a.cwd.trim() : "";
    return { words: cwd ? `In ${cwd}` : "In the workspace" };
  }
  if (tool.startsWith("files.")) {
    // From the turn's home, as the file tools place it: "a.txt" in a project chat is in that project's folder.
    const raw = a.path ?? a.from;
    const where = input.where;
    const placed = where && where.home.folder !== "" && typeof raw === "string" ? placePath(where.home, raw, where.root).path : raw;
    const folder = folderOf(placed);
    return { words: folder ? `In ${folder}` : "In the workspace" };
  }
  if (tool === "http.fetch") {
    const site = hostOf(a.url);
    return site ? { words: `On ${site}` } : undefined;
  }
  const mcp = /^mcp\.([^.]+)\./.exec(tool);
  if (mcp) return { words: `Through ${mcp[1]}` };
  return undefined;
}

/**
 * Why an ask asks, as a phrase to lead with a capital (unless it leads with a host): the rule's own
 * words, less what the place already says ("on docs.google.com", "in your
 * Chrome"). Nothing when all it says is that the tool is risky.
 */
export function askRisk(reason: string | null | undefined): string | undefined {
  const said = (reason ?? "")
    .replace(/,?\s*in your Chrome$/i, "")
    .replace(/^on \S+$/i, "")
    .replace(/^risky tool$/i, "")
    .trim();
  if (!said) return undefined;
  // A host name keeps its own case: "example.com is not one of the sites KOS may reach", never "Example.com".
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+(\s|$)/.test(said) ? said : upperFirst(said);
}

/** What a destination scope ("to:discord:channel:12", "to:project:garden") names, by the name the caller knows it by. */
function destination(what: string, names?: ActionNames): string {
  const bits = what.split(":");
  const [kind, id] = bits.length >= 2 ? [bits[bits.length - 2]!, bits[bits.length - 1]!] : ["", what];
  const named = kind ? names?.(kind, id) : undefined;
  if (named) return kind === "channel" && !named.startsWith("#") ? `#${named}` : named;
  return kind === "channel" ? `#${id}` : id;
}

/** What a remembered yes covers, as its button says it: the site, the folder, the host, the program, where it sends. */
export function alwaysWords(scope: string | null, names?: ActionNames): string {
  const parts = scopeParts(scope);
  if (!parts) return "Always allow";
  const [kind, what] = parts;
  switch (kind) {
    case "to":
      return `Always allow to ${destination(what, names)}`;
    case "your-chrome":
    case "site":
      return `Always allow on ${what}`;
    case "dir":
      return `Always allow in ${what}`;
    case "file":
      return `Always allow on ${what}`;
    case "host":
      return `Always allow on ${what}`;
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
export function alwaysTip(rule: AskRule, names?: ActionNames): string {
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
        keeps = `${calls} in ${what} and the folders under it stops asking${project}.`;
        break;
      case "file":
        keeps = `${calls} on ${what}, that file alone, stops asking${project}.`;
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
      case "to":
        keeps = `${calls} to ${destination(what, names)} stops asking${project}.`;
        break;
      default:
        keeps = `${calls} to the same place stops asking${project}.`;
    }
  }
  return `Approves this, and from now on ${keeps} ${UNDO}`;
}

/** Said on a card asked in a chat set to Auto, for what Auto never covers. */
export const BEYOND_AUTO_NOTE = "Auto never covers this: it asks each time";

/**
 * What a clipboard read would bring in, for the owner to know it before a
 * yes: the start of it, scrubbed by the host, as the card's one step line.
 * A step, never the title, so a notification, which carries the title
 * alone, never shows it.
 */
function clipboardLines(a: Record<string, unknown>): StepLine[] | undefined {
  if (typeof a.preview !== "string") return undefined;
  const length = typeof a.length === "number" ? a.length : a.preview.length;
  const line = a.preview.replace(/\s+/g, " ").trim();
  const cut = line.length > CLIPBOARD_PREVIEW_MAX ? `${line.slice(0, CLIPBOARD_PREVIEW_MAX - 1).trimEnd()}…` : line;
  const all = length > cut.length ? `, the start of ${length.toLocaleString("en-US")} characters` : "";
  return [[{ text: `“${showInvisible(cut)}”${all}` }]];
}

/** An ask, as every card lays it out. */
export function askView(input: AskInput): AskView {
  const { tool, args, reason, rule, names, where, platform } = input;
  const a = argsOf(args);
  const place = askPlace(input);
  const risk = askRisk(reason);
  const acting = actionSteps(tool, args, platform);
  const lines = acting ?? (tool === CLIPBOARD_READ ? clipboardLines(a) : undefined);
  // A run of actions with no purpose said is titled by what it acts on and
  // listed in full; one action alone is its own title.
  // The model's account of a step is its words, said apart and quieter: the
  // card is titled by what the call does, which is what a yes is given for.
  const intent = typeof a.intent === "string" ? a.intent.replace(/\s+/g, " ").trim() : "";
  // A run of actions is listed whole, the most prominent thing on the card, under a title saying what it acts on.
  const steps = lines;
  // A shell command's folder is its place line, so its title is the command alone.
  const titled = { ...a, intent: undefined, ...(tool === "shell.run" ? { cwd: undefined } : {}) };
  const title = acting ? (tool === "computer.act" ? "Use your Mac" : "Act on the page") : summarizeAction(tool, titled, names, where, platform);
  const always = !(input.asksAlways ?? usesSecret(tool, a));
  const secret = input.secret ?? undefined;
  // A secret whose policy is "site" offers its own remembered yes: a grant on this origin, or in this Mac app, kept in the vault.
  const host = secret?.origin ? hostOf(secret.origin) : undefined;
  const site = secret?.remember.includes("site") ? (secret.app ? `in ${secret.app.name}${host ? ` on ${host}` : ""}` : host ? `on ${host}` : undefined) : undefined;
  return {
    title,
    ...(intent ? { said: showInvisible(intent) } : {}),
    ...(place ? { place: place.words } : {}),
    ...(steps ? { steps } : {}),
    ...(risk ? { risk } : {}),
    // A call that places a secret is asked about every time: nothing is remembered for it, so nothing is offered.
    // Nor for what a chat's Auto never covers, asked in one: the owner decides it each time.
    ...(secret ? { secret } : {}),
    ...(site
      ? {
          always: `Approve, and always ${site}`,
          alwaysTip: secret!.app
            ? `Approves this, and from now on ${secret!.label} is typed into password fields ${site} without asking; each use is still recorded. Take it back on the Secrets page.`
            : `Approves this, and from now on ${secret!.label} is filled on ${secret!.origin} without asking; each use is still recorded. Take it back on the Secrets page.`,
        }
      : !always
        ? { alwaysNote: PRIVATE_TOOLS.includes(tool) ? "Asks every time" : "Secrets always ask" }
        : input.beyondAuto
          ? { alwaysNote: BEYOND_AUTO_NOTE }
          : rule
            ? { always: alwaysWords(rule.scope, names), alwaysTip: alwaysTip(rule, names) }
            : {}),
  };
}
