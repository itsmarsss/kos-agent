/**
 * Settings, findable by name.
 *
 * Every section, and every setting the page writes out by hand, under the
 * section it lives in; the ones the host describes (keys, ports) are added
 * from its own words when the page has them. A query matches fuzzily, so
 * "bnd" finds Binding and "chrom" finds Chrome to run, and the best matches
 * come first: the whole word, then where words begin, then letters in order.
 * settingsindex.test.ts keeps this list in step with the page.
 */

/** The rail, grouped by what you came to do. */
export const SECTIONS = [
  { id: "you", group: "Account", label: "You", blurb: "Who KOS thinks it is working for" },
  { id: "providers", group: "Account", label: "Providers", blurb: "API keys and channel credentials" },
  { id: "models", group: "Account", label: "Models", blurb: "Which model answers, which builds, which is cheap" },
  { id: "conversation", group: "Conduct", label: "Conversation", blurb: "How much history is kept" },
  { id: "behaviour", group: "Conduct", label: "Behaviour", blurb: "How KOS acts when you are not watching" },
  { id: "appearance", group: "Conduct", label: "Appearance", blurb: "Palette and density, for this browser" },
  { id: "skills", group: "Extensions", label: "Skills", blurb: "What KOS knows how to do, and which are on" },
  { id: "modules", group: "Extensions", label: "Modules", blurb: "Features built as servers, and which are running" },
  { id: "mcp", group: "Extensions", label: "MCP servers", blurb: "Outside tools, by the protocol they speak" },
  { id: "browser", group: "Extensions", label: "Browser", blurb: "The Chrome KOS drives: its window, extensions and search" },
  { id: "permissions", group: "Access", label: "Permissions", blurb: "Decisions you made at a prompt and kept" },
  { id: "devices", group: "Access", label: "Devices", blurb: "Computers and Chromes KOS may use, and pairing one" },
  { id: "network", group: "Access", label: "Network", blurb: "Ports, binding, and what the agent may reach" },
  { id: "spend", group: "Housekeeping", label: "Spend", blurb: "Tokens used and what they cost" },
  { id: "workspace", group: "Housekeeping", label: "Workspace", blurb: "Where everything lives" },
] as const;

export type SettingsSection = (typeof SECTIONS)[number]["id"];

export const GROUPS = [...new Set(SECTIONS.map((s) => s.group))];

export function isSettingsSection(id: string | undefined): id is SettingsSection {
  return SECTIONS.some((s) => s.id === id);
}

/** One thing to find: a setting, or a heading over a few, in a section. */
export interface SettingEntry {
  section: SettingsSection;
  label: string;
  /** More words it is known by: its hint, or what else it is called. */
  words?: string;
}

/** The settings the page writes out by hand, by section. */
export const SETTINGS: SettingEntry[] = [
  { section: "you", label: "Name", words: "what KOS calls you" },
  { section: "you", label: "Timezone", words: "schedules today time zone" },
  { section: "you", label: "Owner id", words: "identifies you across channels" },
  { section: "models", label: "Who does the thinking" },
  { section: "models", label: "Chat engine", words: "sdk claude api agent loop" },
  { section: "models", label: "Which model answers", words: "reasoning cheap fast model" },
  { section: "models", label: "Build agents" },
  { section: "models", label: "Build model", words: "coding agent builds" },
  { section: "behaviour", label: "When something fails" },
  { section: "behaviour", label: "Extract memory in the background", words: "memory extraction" },
  { section: "behaviour", label: "Try to fix failures on its own", words: "autofix" },
  { section: "behaviour", label: "How hard it tries" },
  { section: "behaviour", label: "Steps in a turn", words: "max steps" },
  { section: "behaviour", label: "Steps in a fix attempt" },
  { section: "behaviour", label: "Unattended work" },
  { section: "behaviour", label: "Check in on its own, every N minutes", words: "heartbeat" },
  { section: "behaviour", label: "Memory extraction: read every N characters of new conversation" },
  { section: "behaviour", label: "Settle a memory question alone when at least N% sure", words: "confidence" },
  { section: "behaviour", label: "Self-prompted jobs per hour", words: "budget" },
  { section: "behaviour", label: "Minutes to wait for your approval", words: "approval timeout" },
  { section: "behaviour", label: "Hours an unanswered ask keeps", words: "approval expiry lapse" },
  { section: "behaviour", label: "Minutes a coding agent may run", words: "build timeout" },
  { section: "behaviour", label: "Turns a coding agent may take" },
  { section: "behaviour", label: "Minutes of silence before an agent looks stuck", words: "stall" },
  { section: "appearance", label: "Theme", words: "dark light system" },
  { section: "appearance", label: "Density", words: "compact comfortable" },
  { section: "appearance", label: "KOS's face", words: "blob avatar colour color icon" },
  { section: "conversation", label: "Trim old exchanges", words: "history" },
  { section: "conversation", label: "History budget", words: "tokens" },
  { section: "conversation", label: "Exchanges kept" },
  { section: "conversation", label: "Tool result cap" },
  { section: "skills", label: "Show", words: "which skills filter project kind state" },
  { section: "skills", label: "Could not be read", words: "broken skills" },
  { section: "modules", label: "Built in", words: "features" },
  { section: "modules", label: "Could not be read", words: "broken modules" },
  { section: "browser", label: "The window" },
  { section: "browser", label: "Show the window on this machine", words: "headed headless" },
  { section: "browser", label: "Chrome to run", words: "binary chromium path" },
  { section: "browser", label: "Extensions" },
  { section: "browser", label: "Unpacked extension folders" },
  { section: "browser", label: "Search" },
  { section: "browser", label: "Where the address bar searches", words: "search engine duckduckgo google" },
  { section: "devices", label: "KOS asks for", words: "session length minutes" },
  { section: "devices", label: "Work you did not start may use a computer", words: "unattended schedules" },
  { section: "devices", label: "Add a device", words: "pair pairing code kos device extension chrome" },
];

export interface SettingHit {
  section: SettingsSection;
  /** The setting, or nothing when the hit is the section itself. */
  label?: string;
  score: number;
  /** Where the query's letters fell in what is shown, to mark them. */
  marks: number[];
}

/**
 * How well `query` matches `text`: its letters in order, scored higher for
 * a match that is one run, that starts a word, and that starts the text.
 * Undefined when the letters are not all there in order.
 */
export function fuzzy(query: string, text: string): { score: number; marks: number[] } | undefined {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return { score: 0, marks: [] };
  const whole = t.indexOf(q);
  if (whole >= 0) {
    const atWord = whole === 0 || !/[a-z0-9]/.test(t[whole - 1]!);
    return { score: 100 + (atWord ? 40 : 0) + (whole === 0 ? 20 : 0) - t.length / 100, marks: [...q].map((_, i) => whole + i) };
  }
  const marks: number[] = [];
  let score = 0;
  let from = 0;
  for (const ch of q) {
    if (ch === " ") continue;
    const at = t.indexOf(ch, from);
    if (at < 0) return undefined;
    const atWord = at === 0 || !/[a-z0-9]/.test(t[at - 1]!);
    score += atWord ? 8 : 0;
    score += marks.length && at === marks[marks.length - 1]! + 1 ? 5 : 0;
    score -= Math.min(at - from, 10) * 0.5;
    marks.push(at);
    from = at + 1;
  }
  return { score, marks };
}

/**
 * The settings and sections a query finds, best first. Each word of the
 * query must match the label, its words, or its section's name; a match on
 * the label itself counts most.
 */
export function searchSettings(query: string, entries: SettingEntry[] = SETTINGS, limit = 12): SettingHit[] {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const hits: SettingHit[] = [];
  const consider = (section: SettingsSection, label: string | undefined, shown: string, more: string): void => {
    let score = 0;
    const marks: number[] = [];
    for (const word of words) {
      const onShown = fuzzy(word, shown);
      const onMore = fuzzy(word, more);
      if (!onShown && !onMore) return;
      if (onShown && (!onMore || onShown.score + 20 >= onMore.score)) {
        score += onShown.score + 20;
        marks.push(...onShown.marks);
      } else score += onMore!.score;
    }
    hits.push({ section, ...(label !== undefined ? { label } : {}), score, marks: [...new Set(marks)].sort((a, b) => a - b) });
  };
  for (const s of SECTIONS) consider(s.id, undefined, s.label, `${s.blurb} ${s.group}`);
  for (const e of entries) {
    const section = SECTIONS.find((s) => s.id === e.section)!;
    consider(e.section, e.label, e.label, `${e.words ?? ""} ${section.label}`);
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
