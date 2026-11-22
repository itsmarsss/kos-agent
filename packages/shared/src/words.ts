/**
 * What the dashboard calls things, in one table (docs/design.md, Words), so
 * two pages never name one thing two ways: a kind tag in sentence case, a
 * schedule never a "cron" or a "job", KOS's own replies by KOS's name.
 */

/** Each kind as a tag says it. */
export const KIND_WORDS: Readonly<Record<string, string>> = {
  project: "Project",
  system: "System",
  orchestrator: "Orchestrator",
  blob: "Blob",
  agent: "Agent",
  build: "Build",
  chat: "Chat",
  turn: "Turn",
  job: "Schedule",
  cron: "Schedule",
  schedule: "Schedule",
  tool: "Tool",
  owner: "You",
  user: "You",
  assistant: "KOS",
  kos: "KOS",
  doc: "Doc",
  deck: "Deck",
  sheet: "Sheet",
  page: "Page",
  login: "Login",
  card: "Card",
  apikey: "API key",
  "api-key": "API key",
  api_key: "API key",
  note: "Note",
};

/** A kind in the words a tag shows: from the table, else its own word with a capital. */
export function kindWord(kind: string): string {
  const known = KIND_WORDS[kind.toLowerCase()];
  if (known) return known;
  const plain = kind.replace(/[-_]+/g, " ").trim();
  return plain ? plain[0]!.toUpperCase() + plain.slice(1) : plain;
}

/**
 * KOS's own schedules by the one name each goes by, wherever it is listed:
 * the three memory schedules as "Memory: Read" and so on, on Runs and on
 * Memory alike. The ids (kos.memory) are the store's, kept for tooltips.
 */
export const SYSTEM_SCHEDULES: Readonly<Record<string, string>> = {
  "kos.memory": "Memory: Read",
  "kos.dream": "Memory: Tidy",
  "kos.observe": "Memory: Condense",
  "kos.backup": "Backup",
  "kos.face": "Faces",
  "kos.improve": "Improve",
};

/**
 * A name as the owner gave it or would say it, for something stored by a
 * slug: "plant-watcher" as "Plant watcher". Only for a slug with no name of
 * its own on hand; a blob's or a project's own name always wins.
 */
export function slugWords(slug: string): string {
  const plain = slug.replace(/[-_]+/g, " ").trim();
  return plain ? plain[0]!.toUpperCase() + plain.slice(1) : slug;
}
