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
 * A schedule's name as every list writes it: KOS's own by the one name each
 * goes by (the memory schedules as "Memory: Read"), a blob's as the blob's
 * name, the owner's as they named it. The ids (kos.memory, blob.recap) are
 * the store's, never shown.
 */
export function scheduleName(name: string): string {
  const own = SYSTEM_SCHEDULES[name];
  if (own) return own;
  if (name.startsWith("blob.")) return slugWords(name.slice(5));
  return name;
}

/** What each of KOS's own schedules does, in a sentence or two, for its sheet and the Memory page. */
export const SYSTEM_SCHEDULE_ABOUT: Readonly<Record<string, string>> = {
  "kos.memory": "Reads what was said since it last ran and keeps what will still be true months from now in Memory, with the messages each thing came from.",
  "kos.dream": "Tidies Memory: joins two entries that say the same thing, puts away ones that are over, and asks you about any that disagree. Then it rewrites the pages that sum up what KOS knows.",
  "kos.observe": "Keeps long chats readable: writes a dated note of the older part of a long chat, and that note takes the older part's place in what KOS rereads.",
  "kos.backup": "Saves a copy of the workspace, so a file KOS changed or removed can be brought back.",
  "kos.face": "Draws the faces KOS and its blobs show.",
  "kos.improve": "Looks over KOS's recent work for things worth making reusable, and suggests them to you in the Inbox. It never makes anything itself.",
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

/** Providers by the names they go by; "custom" is the owner's own server, never the store's word for it. */
const PROVIDER_WORDS: Readonly<Record<string, string>> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  custom: "Your own server",
};

/** A model provider as the owner reads it: "Your own server" for custom, a known one by its name, any other as stored. */
export function providerWord(provider: string): string {
  return PROVIDER_WORDS[provider] ?? provider;
}
