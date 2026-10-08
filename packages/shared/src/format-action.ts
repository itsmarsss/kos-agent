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

/** One-line summary for a tool + args. */
export function summarizeAction(
  tool: string,
  args: string | Record<string, unknown>,
): string {
  const a = parseArgs(args);
  switch (tool) {
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
    case "notify":
      return `Notify: ${fmtVal(a.text)}`;
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
      return `Run scheduled job #${fmtVal(a.id)} now`;
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
      return `Commit skill ${fmtVal(a.name)}`;
    default:
      break;
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
): string[] {
  const a = parseArgs(args);
  const lines: string[] = [];
  // Prefer a short summary line first.
  lines.push(summarizeAction(tool, a));
  const keys = Object.keys(a).slice(0, MAX_FIELDS);
  for (const k of keys) {
    lines.push(`${k}: ${fmtVal(a[k])}`);
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
): string {
  const summary = summarizeAction(tool, args);
  const lines = [
    `**Approval needed** · pending \`#${id}\``,
    "",
    summary,
  ];
  if (reason) lines.push(`_Reason: ${reason}_`);
  lines.push("", "Use the buttons below.");
  return lines.join("\n");
}
