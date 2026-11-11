/**
 * Human-readable summaries of tool calls for approvals and dashboard UI.
 * Keeps raw JSON out of the user's face.
 */

const MAX_VALUE = 120;
const MAX_FIELDS = 6;

function truncate(s: string, n = MAX_VALUE): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
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

/** At most this many parts in a step's line; the rest are counted. */
const MAX_PARTS = 4;
/** A single action this short may follow the step's purpose, in parentheses. */
const SHORT_MECHANICS = 24;

const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);
const upperFirst = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** A name the formatter does not know, as words: "hold_key" is "Hold key". */
const itself = (name: string): string => upperFirst(name.replace(/_/g, " ").trim());

/** One action of a step: the words it reads as, and the action as the model wrote it. */
interface Part {
  words: string;
  raw: unknown;
}

/** The same value, whatever order its keys were written in. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * The parts of one step as a line: repeats folded ("press Tab ×3"), the
 * first few said and the rest counted, so a long run stays readable. Only
 * the same action repeated folds: two clicks that read alike but land in
 * different places are two clicks.
 */
function joinParts(parts: Part[], cap = MAX_PARTS): string {
  const folded: string[] = [];
  let run = 0;
  for (const [i, part] of parts.entries()) {
    run += 1;
    const next = parts[i + 1];
    if (next && same(next.raw, part.raw)) continue;
    folded.push(run > 1 ? `${part.words} ×${run}` : part.words);
    run = 0;
  }
  const said = folded.length > cap ? folded.slice(0, cap - 1) : folded;
  const rest = folded.length - said.length;
  const line = said.map((p, i) => (i === 0 ? p : lowerFirst(p))).join(", ");
  return rest ? `${line} and ${rest} more` : line;
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
  const only = parts.length === 1 ? parts[0]!.words : "";
  return only && only.length <= SHORT_MECHANICS ? `${head} (${lowerFirst(only)})` : head;
}

/** One computer action in words. Coordinates name nothing the owner can see, so they are left out. */
function computerAction(a: Record<string, unknown>): string {
  const action = typeof a.action === "string" ? a.action : "";
  const click = COMPUTER_CLICKS[action];
  if (click) return `${click}${typeof a.text === "string" && a.text ? ` holding ${a.text}` : ""}`;
  switch (action) {
    case "":
      return "Use the computer";
    case "screenshot":
      return "Look at the screen";
    case "zoom":
      return "Look closer at part of the screen";
    case "mouse_move":
      return "Move the pointer";
    case "left_click_drag":
      return "Drag";
    case "scroll":
      return `Scroll ${fmtVal(a.scroll_direction ?? "down")}${typeof a.scroll_amount === "number" ? ` ${a.scroll_amount}` : ""}`;
    case "type":
      return `Type “${fmtVal(a.text)}”`;
    case "key":
      return `Press ${fmtVal(a.text)}`;
    case "wait":
      return `Wait ${fmtVal(a.duration ?? 1)}s`;
    default:
      return itself(action);
  }
}

/** A computer step as what it does on the screen; a device id names nothing the owner knows, so it is left out. */
function computerStep(tool: string, a: Record<string, unknown>): string {
  if (tool === "computer.devices") return "List the paired computers";
  if (tool === "computer.end") return "Give the computer back";
  if (tool === "computer.start") {
    const device = typeof a.device === "string" && !a.device.startsWith("dev_") ? a.device : "a computer";
    return `Use ${device}: ${fmtVal(a.task)}`;
  }
  if (tool === "computer.act") return withIntent(a.intent, actParts(tool, a));
  return itself(tool.slice("computer.".length)) || "Use the computer";
}

/** A browser.act target in words: the text it names, a selector as written, nothing for a @ref. */
function targetWords(v: unknown): string {
  const t = v && typeof v === "object" ? ((v as Record<string, unknown>)["target"] ?? (v as Record<string, unknown>)["selector"]) : v;
  if (typeof t !== "string" || !t || t.startsWith("@")) return "";
  const text = /^text=(.+)$/.exec(t)?.[1] ?? /:has-text\(['"](.+)['"]\)/.exec(t)?.[1];
  return text ? ` “${truncate(text, 40)}”` : ` ${truncate(t, 40)}`;
}

/** One browser.act step in words. */
function browserStep(s: Record<string, unknown>): string {
  const key = Object.keys(s)[0] ?? "";
  const v = s[key];
  const field = (name: string): unknown => (v && typeof v === "object" ? (v as Record<string, unknown>)[name] : undefined);
  switch (key) {
    case "click":
      return `Click${targetWords(v)}`;
    case "dblclick":
      return `Double-click${targetWords(v)}`;
    case "rightclick":
      return `Right-click${targetWords(v)}`;
    case "hover":
      return `Point at${targetWords(v) || " something"}`;
    case "drag":
      return "Drag";
    case "fill":
      return `Fill in “${fmtVal(field("text"))}”`;
    case "type":
      return `Type “${fmtVal(field("text"))}”`;
    case "press":
      return `Press ${fmtVal(v)}`;
    case "select": {
      const values = field("values");
      return `Choose ${fmtVal(Array.isArray(values) ? values.join(", ") : values)}`;
    }
    case "check":
      return `Tick${targetWords(v)}`;
    case "uncheck":
      return `Untick${targetWords(v)}`;
    case "scroll":
      return v === "up" || v === "down" ? `Scroll ${v}` : `Scroll to${targetWords(v) || " something"}`;
    case "open":
      return `Open ${fmtVal(v)}`;
    case "go":
      return v === "reload" ? "Reload the page" : `Go ${fmtVal(v)}`;
    case "wait":
      return typeof field("text") === "string" ? `Wait for “${fmtVal(field("text"))}”` : "Wait";
    case "dialog":
      return v === "accept" ? "Accept the dialog" : "Dismiss the dialog";
    case "":
      return "Act on the page";
    default:
      return itself(key);
  }
}

/**
 * The actions of one computer.act or browser.act call, each in words, by one
 * rule for both: the call's `actions` (or `steps`, the browser's older name
 * for them), or a computer's single action. Every surface's step line, its
 * mechanics and the narrator are made from these.
 */
function actParts(tool: string, a: Record<string, unknown>): Part[] {
  const computer = tool === "computer.act";
  const list = Array.isArray(a.actions) ? a.actions : Array.isArray(a.steps) ? a.steps : computer ? [a] : [];
  const words = (item: unknown): string => {
    const action = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    return computer ? computerAction(action) : browserStep(action);
  };
  const parts = list.map((item) => ({ words: words(item), raw: item as unknown }));
  return parts.length ? parts : [{ words: computer ? "Use the computer" : "Act on the page", raw: null }];
}

/**
 * How a step does what its line says, when the line says what it is for
 * instead: every action of a computer.act or browser.act that carries an
 * intent, in order, none folded and none left out, since an approval is
 * given for these and not for the model's account of them. Undefined where
 * the line already is the mechanics.
 */
export function stepActions(tool: string, args: string | Record<string, unknown>): string[] | undefined {
  const a = parseArgs(args);
  if (typeof a.intent !== "string" || !a.intent.trim()) return undefined;
  return tool === "computer.act" || tool === "browser.act" ? actParts(tool, a).map((p) => p.words) : undefined;
}

/** stepActions as one line. */
export function stepMechanics(tool: string, args: string | Record<string, unknown>): string | undefined {
  return stepActions(tool, args)?.map((w, i) => (i === 0 ? w : lowerFirst(w))).join(", ");
}

/** One-line summary for a tool + args, with names for the ids the caller can name. */
export function summarizeAction(
  tool: string,
  args: string | Record<string, unknown>,
  names?: ActionNames,
): string {
  const a = parseArgs(args);
  // A name where one is known, the value as written otherwise: an id alone
  // is no basis for a yes, and the id stays in the detail lines.
  const named = (kind: string, raw: unknown, fallback = fmtVal(raw)): string => {
    const id = typeof raw === "string" ? raw : typeof raw === "number" ? String(raw) : "";
    return (id && names?.(kind, id)) || fallback;
  };
  switch (tool) {
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
      return `Write file ${fmtVal(a.path)}`;
    case "files.rm":
      return `Delete ${fmtVal(a.path)}`;
    case "files.mkdir":
      return `Create folder ${fmtVal(a.path)}`;
    case "files.ls":
      return `List ${fmtVal(a.path)}`;
    case "files.read":
      return `Read ${fmtVal(a.path)}`;
    case "files.edit":
      return `Edit ${fmtVal(a.path)}`;
    case "files.cp":
      return `Copy ${fmtVal(a.from)} to ${fmtVal(a.to)}`;
    case "files.mv":
      return `Move ${fmtVal(a.from)} → ${fmtVal(a.to)}`;
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
      return `Search for “${fmtVal(a.pattern)}”`;
    case "search.semantic":
      return `Recall about “${fmtVal(a.query)}”`;
    case "export.query":
      return `Export ${fmtVal(a.format)} to ${fmtVal(a.path)}`;
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
      return `Run: ${fmtVal(a.command)}${a.cwd ? ` (in ${fmtVal(a.cwd)})` : ""}`;
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
  if (tool.startsWith("computer.")) return computerStep(tool, a);
  if (tool === "chrome.start") return `Work in your Chrome${typeof a.chrome === "string" ? ` (${a.chrome})` : ""}: ${fmtVal(a.task)}`;
  if (tool === "chrome.end") return "Give your Chrome back";
  if (tool === "chrome.page") return "Read the page beside the panel";
  if (tool === "python.run") return `Run Python: ${fmtVal(typeof a.code === "string" ? (a.code.split("\n").find((l) => l.trim()) ?? "").trim() : a.code)}`;
  if (tool === "tex.pdf") return `Typeset ${fmtVal(a.path)} as a PDF`;
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
  if (tool === "browser.act") return withIntent(a.intent, actParts(tool, a));
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
): string[] {
  const a = parseArgs(args);
  const lines: string[] = [];
  // Prefer a short summary line first.
  lines.push(summarizeAction(tool, a, names));
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
