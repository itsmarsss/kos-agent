/**
 * What a chat's Auto mode never lets through without the owner, decided
 * deterministically from the tool and its arguments, as every risk rule is.
 * A tool's own `beyondAuto` (its ToolRisk) says the same for what only the
 * tool can see, such as whether a path is a folder or a page is a checkout;
 * these are the rules that read the name and the arguments alone. The menu's
 * "Auto never covers" is this list in words.
 */

const PAYS = /(^|[^a-z])(pay|payment|purchase|checkout|charge|buy|order|transfer|send_money|refund|donate|subscribe)(?![a-z])/;
const DELETES = /(^|[^a-z])(delete|remove|destroy|drop|purge|trash|erase|wipe|unlink|rm|cancel|revoke)(?![a-z])/;

/** Why Auto does not cover a tool by this name (one KOS did not write: an MCP server's), or false. */
export function beyondAutoByName(name: string): string | false {
  // Words split where camelCase joins them: removeLabel reads as remove_label, sendMoney as send_money.
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  if (PAYS.test(words)) return "may spend money";
  if (DELETES.test(words)) return "may delete or cancel something outside the workspace";
  return false;
}

/** KOS's own tools that undo something for good, or change what KOS itself is: never under Auto. */
const PERMANENT: Record<string, string> = {
  "systems.project_delete": "deletes a project for good",
  "chats.delete": "deletes a chat for good",
  "blobs.remove": "removes a standing helper for good",
  "daemons.remove": "removes a daemon for good",
  "discord.prune": "deletes threads on the server",
  "skills.commit": "commits code KOS runs from now on",
  "skills.promote": "makes a skill part of KOS",
  "modules.instantiate": "adds a module to KOS",
};

/** Whether a notify reaches someone besides the owner: a channel or another user. */
function notifiesOthers(input: Record<string, unknown>): boolean {
  const to = typeof input["to"] === "string" ? input["to"].trim() : "";
  return to.startsWith("channel:") || to.startsWith("user:");
}

/**
 * Why Auto never covers this call of one of KOS's own tools, or false. A
 * message to anyone but the owner, a place opened to others, and what
 * deletes for good or changes KOS itself ask as they would in Ask.
 */
export function beyondAutoRule(tool: string, input: Record<string, unknown>): string | false {
  const permanent = PERMANENT[tool];
  if (permanent) return permanent;
  if (tool === "notify" && notifiesOthers(input)) return "messages someone besides you";
  if (tool === "discord.audience" && input["audience"] !== "owner") return "lets people besides you see a channel";
  if (tool === "discord.access") return "changes who may see a place on the server";
  return false;
}

/**
 * What a shell command line would destroy past undoing, or false: a
 * recursive delete, a forced push or a hard reset, a wipe of untracked
 * files, a raw disk write, a format, a recursive change of owner or mode,
 * and a redirect that truncates a file that exists outside the scratch
 * folder. `exists` says whether a workspace path is there now; `scratch`
 * whether it is in the scratch folder.
 */
export function destructiveCommand(command: string, exists: (path: string) => boolean, scratch: (path: string) => boolean): string | false {
  const line = command.replace(/\\\n/g, " ");
  if (/(^|[\s;&|(])rm\s+(?:[^;&|\n]*\s)?(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b/.test(line)) return "deletes recursively";
  if (/\bgit\s+push\b[^;&|\n]*\s(?:--force(?:-with-lease)?|-[a-zA-Z]*f[a-zA-Z]*|\+\S+)/.test(line)) return "force-pushes";
  if (/\bgit\s+reset\b[^;&|\n]*\s--hard\b/.test(line)) return "throws work away with git reset --hard";
  if (/\bgit\s+clean\b/.test(line)) return "deletes untracked files with git clean";
  if (/(^|[\s;&|(])dd\s[^;&|\n]*\bof=/.test(line)) return "writes raw bytes with dd";
  if (/(^|[\s;&|(])mkfs(\.[a-z0-9]+)?\b/.test(line)) return "formats a disk";
  if (/(^|[\s;&|(])(chmod|chown)\s+(?:[^;&|\n]*\s)?(?:-[a-zA-Z]*R[a-zA-Z]*|--recursive)\b/.test(line)) return "changes owner or mode recursively";
  // A lone > (not >>, not 2>&1) truncates its target: one that exists outside scratch is lost.
  for (const m of line.matchAll(/(?:^|[^>&0-9])[01]?>\|?\s*([^\s;&|<>()]+)/g)) {
    const target = m[1]!.replace(/^["']|["']$/g, "");
    if (target.startsWith("/dev/") || target.startsWith("&")) continue;
    if (!scratch(target) && exists(target)) return `overwrites ${target}`;
  }
  return false;
}
