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
    case "pages.write":
      return `Write page for project ${fmtVal(a.project)}`;
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
    case "pages.get":
      return `Read page ${fmtVal(a.id)}`;
    case "pages.list":
      return "List pages";
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
  // KOS's own browser tools: a visit, a run of steps, or the owner's hands.
  if (tool === "browser.visit") {
    // One visit may take several pages; the card names them all.
    const urls = [...(typeof a.url === "string" && a.url ? [a.url] : []), ...(Array.isArray(a.urls) ? a.urls.filter((u): u is string => typeof u === "string" && u !== "") : [])];
    return `Visit ${urls.length ? urls.join(", ") : fmtVal(a.url)}`;
  }
  if (tool === "browser.handoff") return `Needs your hands: ${fmtVal(a.reason)}`;
  if (tool === "browser.tabs") return "List the browser's tabs";
  if (tool === "browser.use_tab") return `Switch to tab ${fmtVal(a.tab)}`;
  if (tool === "browser.new_tab") return a.url !== undefined ? `Open a new tab at ${fmtVal(a.url)}` : "Open a new tab";
  if (tool === "browser.watch") return `Watch ${fmtVal(a.name ?? a.url)} for change`;
  if (tool === "browser.act") {
    const steps = Array.isArray(a.steps) ? (a.steps as Record<string, unknown>[]) : [];
    const said = steps.slice(0, 4).map((s) => {
      const key = Object.keys(s)[0] ?? "step";
      const v = s[key];
      const what = typeof v === "string" ? v : typeof v === "number" ? `${v}ms` : v && typeof v === "object" && typeof (v as Record<string, unknown>)["selector"] === "string" ? String((v as Record<string, unknown>)["selector"]) : "";
      return `${key}${what ? ` ${what}` : ""}`;
    });
    return `On the page: ${said.join(", ")}${steps.length > 4 ? `, +${steps.length - 4} more` : ""}`;
  }
  // The browser engine's actions read as what they do to the page; the
  // approval's small print says which site, since the call does not.
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
