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

/**
 * Why Auto never covers this call of one of KOS's own tools, or false. A
 * place opened to others, and what deletes for good or changes KOS itself
 * ask as they would in Ask. A message to anyone but the owner is notify's
 * own rule (sendsElsewhere), so the two never disagree.
 */
export function beyondAutoRule(tool: string, input: Record<string, unknown>): string | false {
  const permanent = PERMANENT[tool];
  if (permanent) return permanent;
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

/** A page address that is a checkout or a payment step. */
const CHECKOUT_PATH = /(^|[/._-])(checkout|payment|payments|pay|purchase|place-?order|billing)([/._?#-]|$)/i;
/** Words a checkout or payment page shows. */
const CHECKOUT_WORDS = /\b(checkout|check out|place (?:your )?order|buy now|pay now|payment)\b/i;

/** What a browser step's page tells of it: its text, and whether it has a card field (autocomplete cc-*). */
export interface PageLook {
  text: string;
  cardField: boolean;
}

/**
 * Whether a browser step acts on a checkout or a payment page, in KOS's
 * browser or the owner's Chrome, so a chat's Auto does not take it: an
 * address on the way (the tab's, one a step opens) whose path is a checkout,
 * a card field on the page, or a checkout's words on it.
 */
export function looksLikeCheckout(urls: readonly string[], page: PageLook | undefined): string | false {
  for (const url of urls) {
    let path = url;
    try {
      const u = new URL(url);
      path = `${u.pathname}${u.search}`;
    } catch {
      // A bare address is read as it was given.
    }
    if (CHECKOUT_PATH.test(path)) return "acts on a checkout or payment page";
  }
  if (page?.cardField) return "acts on a page with a card field";
  if (page && CHECKOUT_WORDS.test(page.text)) return "acts on a page that reads like a checkout";
  return false;
}

/** The addresses a browser call's steps would open: every string under an open, goto, url or visit key. */
export function addressesIn(input: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, key?: string): void => {
    if (typeof v === "string") {
      if (key && /^(open|goto|url|visit|href|navigate)$/i.test(key)) out.push(v);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(input);
  return out;
}
