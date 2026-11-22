/**
 * What a tool does, as the owner would say it, for every list and chip that
 * names a step: "List files", never "files.ls". The tool's own name and its
 * arguments stay for the Details a curious owner opens (`summarizeAction`
 * says the full step, with its path or its address).
 */

/** Each tool the owner may see a step of, by what it does. */
export const TOOL_WORDS: Readonly<Record<string, string>> = {
  "files.read": "Read a file",
  "files.write": "Write a file",
  "files.edit": "Edit a file",
  "files.ls": "List files",
  "files.list": "List files",
  "files.mv": "Move a file",
  "files.cp": "Copy a file",
  "files.rm": "Delete a file",
  "files.mkdir": "Make a folder",
  "file.trash": "Move a file to the trash",
  "file.restore": "Restore a file",
  "file.delete": "Delete a file for good",
  sql: "Look in a table",
  "systems.migrate": "Change a table",
  "systems.project_create": "Make a project",
  "systems.project_delete": "Delete a project",
  "systems.project_list": "List projects",
  shell: "Run a command",
  "shell.run": "Run a command",
  "python.run": "Run Python",
  "danger.run": "Run a command",
  "http.fetch": "Fetch a web address",
  notify: "Send you a message",
  "functions.notify": "Send you a message",
  "search.grep": "Search the files",
  "search.semantic": "Search by meaning",
  "context.recall": "Look back in the chat",
  "export.query": "Export a table",
  "tex.pdf": "Make a PDF",
  "cron.schedule": "Set up a schedule",
  "cron.list": "List schedules",
  "cron.remove": "Delete a schedule",
  "cron.run": "Run a schedule now",
  "artifacts.write": "Write an artifact",
  "artifacts.patch": "Change an artifact",
  "artifacts.check": "Check an artifact",
  "artifacts.guide": "Read the artifact guide",
  "artifacts.get": "Read an artifact",
  "artifacts.list": "List artifacts",
  "artifacts.history": "Read an artifact's history",
  "artifacts.rollback": "Restore an artifact's version",
  "artifacts.rename": "Rename an artifact",
  "artifacts.duplicate": "Duplicate an artifact",
  "artifacts.move": "Move an artifact",
  "artifacts.trash": "Move an artifact to the trash",
  "artifact.rename": "Rename an artifact",
  "artifact.duplicate": "Duplicate an artifact",
  "artifact.move": "Move an artifact",
  "artifact.trash": "Move an artifact to the trash",
  "artifact.restore": "Restore an artifact",
  "artifact.delete": "Delete an artifact for good",
  "pages.write": "Write a page",
  "memory.remember": "Remember something",
  "memory.recall": "Recall what it knows",
  "memory.forget": "Forget something",
  "memory.tags": "List memory tags",
  "memory.page": "Read a memory page",
  "memory.pages": "List memory pages",
  "memory.review": "Review memory",
  "memory.merge": "Merge two memories",
  "memory.archive": "Put a memory away",
  "memory.flag": "Flag a memory",
  "memory.observe": "Note what happened",
  "memory.trace": "Trace where a memory came from",
  "memory.thread": "Read a thread's notes",
  "memory.threads": "List threads' notes",
  "memory.unread": "Read what is new",
  "memory.mark_read": "Mark notes read",
  "memory.import_page": "Save a page to memory",
  "secrets.write": "Save a secret",
  "secrets.list": "List secrets",
  "secrets.request": "Ask you for a secret",
  "secrets.fill": "Fill in a secret",
  "secrets.type": "Type a secret",
  "secrets.allow_site": "Allow a secret on a site",
  "vault.fill": "Fill in a secret",
  "skills.list": "List skills",
  "skills.create": "Write a skill",
  "skills.test": "Test a skill",
  "skills.promote": "Promote a skill",
  "skills.commit": "Save a skill",
  "skills.run": "Run a skill",
  "skills.use": "Load a skill",
  "chats.list": "List chats",
  "chats.search": "Search chats",
  "chats.read": "Read a chat",
  "chats.create": "Start a chat",
  "chats.dispatch": "Hand work to a chat",
  "chats.handoff": "Hand work on",
  "chats.archive": "Archive a chat",
  "chats.delete": "Delete a chat",
  "chats.project": "Start a project",
  "chats.congregate": "Gather from chats",
  "blobs.list": "List blobs",
  "blobs.create": "Make a blob",
  "blobs.dispatch": "Hand work to a blob",
  "blobs.pause": "Pause a blob",
  "blobs.resume": "Resume a blob",
  "blobs.remove": "Remove a blob",
  "builds.run": "Start a build",
  "daemons.create": "Set up a background program",
  "daemons.list": "List background programs",
  "daemons.start": "Start a background program",
  "daemons.stop": "Stop a background program",
  "daemons.remove": "Remove a background program",
  "daemons.logs": "Read a background program's log",
  "tasks.create_list": "Make a task list",
  "tasks.add": "Add a task",
  "tasks.complete": "Tick off a task",
  "tasks.list": "List tasks",
  "modules.create": "Make a module",
  "modules.promote": "Promote a project",
  "modules.instantiate": "Make a copy of a module",
  "modules.list": "List modules",
  "improve.list": "List improvements",
  "improve.suggest": "Suggest an improvement",
  "sites.create": "Make a site",
  "sites.list": "List sites",
  "browser.visit": "Visit a page",
  "browser.act": "Work in a page",
  "browser.click": "Click in a page",
  "browser.look": "Look at the page",
  "browser.eval": "Run a script in a page",
  "browser.handoff": "Ask for your hands",
  "browser.tabs": "List the browser's tabs",
  "browser.use_tab": "Switch tabs",
  "browser.new_tab": "Open a tab",
  "browser.watch": "Watch a page",
  "chrome.start": "Work in your Chrome",
  "chrome.end": "Give your Chrome back",
  "chrome.page": "Read the page beside the panel",
  "computer.devices": "List your computers",
  "computer.start": "Work on your computer",
  "computer.act": "Work on your computer",
  "computer.end": "Give your computer back",
  "discord.bind": "Link a Discord channel",
  "discord.make": "Make a Discord channel",
  "discord.access": "Set who may use a channel",
  "discord.audience": "Open or close a channel",
  "discord.role": "Make a Discord role",
  "discord.prune": "Tidy Discord threads",
  "discord.react": "React on Discord",
  "discord.messages": "Read Discord messages",
  "discord.channels": "List Discord channels",
  "shop.pay": "Pay",
};

/** A family's words, for a tool of it the table does not name. */
const FAMILY_WORDS: Readonly<Record<string, string>> = {
  files: "Work with files",
  file: "Work with files",
  systems: "Work on a project",
  artifacts: "Work on an artifact",
  artifact: "Work on an artifact",
  memory: "Work with memory",
  secrets: "Use a secret",
  skills: "Work with skills",
  chats: "Work with chats",
  blobs: "Work with blobs",
  cron: "Work with schedules",
  daemons: "Work with background programs",
  tasks: "Work with tasks",
  browser: "Work in a page",
  chrome: "Work in your Chrome",
  computer: "Work on your computer",
  discord: "Work in Discord",
  search: "Search",
  modules: "Work with modules",
};

/**
 * A step's tool as the owner would say it: from the table, else its
 * family's words, else a server's tool as "<tool> on <server>", else the
 * name with its dots and underscores read as spaces.
 */
export function toolWords(tool: string): string {
  const known = TOOL_WORDS[tool];
  if (known) return known;
  const mcp = /^mcp\.([^.]+)\.(.+)$/.exec(tool);
  if (mcp) return `${plain(mcp[2]!)} on ${mcp[1]}`;
  const family = FAMILY_WORDS[tool.split(".")[0] ?? ""];
  if (family) return family;
  return plain(tool);
}

function plain(name: string): string {
  const words = name.replace(/[._-]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : name;
}

/** The arguments that say what a step was done to, in the order a sentence would reach for them; never an id or a handle. */
const TARGET_KEYS = ["path", "from", "url", "title", "name", "query", "pattern", "command", "text"] as const;
const TARGET_MAX = 80;

/**
 * A step as a list row says it: what it did, and what it did it to when an
 * argument says so ("Read a file", "notes/todo.md"). The arguments
 * themselves, the tool's name and any id are for Details.
 */
export function stepLine(tool: string, args: unknown): { title: string; detail?: string } {
  const title = toolWords(tool);
  const a = typeof args === "string" ? parseObject(args) : args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  for (const key of TARGET_KEYS) {
    const v = a[key];
    if (typeof v !== "string" || !v.trim()) continue;
    const one = v.replace(/\s+/g, " ").trim();
    return { title, detail: one.length > TARGET_MAX ? `${one.slice(0, TARGET_MAX - 1)}…` : one };
  }
  return { title };
}

function parseObject(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
