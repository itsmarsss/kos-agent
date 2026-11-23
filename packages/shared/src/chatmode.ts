/**
 * A chat's mode: how KOS treats a risky step in it.
 *
 * Ask, the default, asks the owner before each one, as the approval queue
 * always has. Auto goes ahead without asking, for the owner's own turns in
 * that chat, within what Auto never covers. Every surface sets it from its
 * composer's chip, Auto only as a choice in its menu, never by a key; the
 * harness alone decides what it lets through.
 */

export type ChatModeName = "ask" | "auto";

/** The order a press on the chip goes through. */
export const CHAT_MODES: readonly ChatModeName[] = ["ask", "auto"];

export interface ChatMode {
  mode: ChatModeName;
  /** When Auto ends of itself: an epoch ms, or "task" for when the chat's next turn finishes. None lasts until turned off. */
  until?: number | "task";
  /** Auto also starts Mac and Chrome sessions the device leaves to KOS's approvals. */
  sessions?: boolean;
}

export const ASK: ChatMode = { mode: "ask" };

/** The mode after this one, round the cycle. */
export function nextMode(mode: ChatModeName): ChatModeName {
  return CHAT_MODES[(CHAT_MODES.indexOf(mode) + 1) % CHAT_MODES.length]!;
}

/** What a press on the chip makes of a mode: the next one, Auto with no bounds; the menu sets those. */
export function cycled(mode: ChatMode): ChatMode {
  return nextMode(mode.mode) === "auto" ? { mode: "auto" } : ASK;
}

/** The mode as it stands at `now`: Ask when none is kept or Auto's time ran out. */
export function liveMode(mode: ChatMode | undefined, now: number): ChatMode {
  if (!mode || mode.mode !== "auto") return ASK;
  return typeof mode.until === "number" && mode.until <= now ? ASK : mode;
}

/** A mode said on the wire, checked: undefined for anything that is not one. */
export function parseChatMode(raw: unknown): ChatMode | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (r["mode"] === "ask") return ASK;
  if (r["mode"] !== "auto") return undefined;
  const until = r["until"];
  return {
    mode: "auto",
    ...(until === "task" || (typeof until === "number" && Number.isFinite(until) && until > 0) ? { until } : {}),
    ...(r["sessions"] === true ? { sessions: true } : {}),
  };
}

/** How long Auto may be set for, as the chip's menu offers it. */
export interface AutoSpan {
  id: "off" | "task" | "1h" | "8h";
  label: string;
  /** The same in a word or two, for a chip. */
  short: string;
}

export const AUTO_SPANS: readonly AutoSpan[] = [
  { id: "off", label: "Until I turn it off", short: "Until off" },
  { id: "task", label: "Until this task finishes", short: "This task" },
  { id: "1h", label: "For 1 hour", short: "1 hour" },
  { id: "8h", label: "For 8 hours", short: "8 hours" },
];

/** The `until` a span sets, from `now`. */
export function untilOf(span: AutoSpan["id"], now: number): ChatMode["until"] {
  if (span === "task") return "task";
  if (span === "1h") return now + 3_600_000;
  if (span === "8h") return now + 8 * 3_600_000;
  return undefined;
}

/** The span a mode was set for, to light its line in the menu; "timed" for an hour count, which the chip counts down. */
export function spanOf(mode: ChatMode): Exclude<AutoSpan["id"], "1h" | "8h"> | "timed" {
  if (mode.until === "task") return "task";
  return mode.until === undefined ? "off" : "timed";
}

/** Time left, as a person says it: "45m", "7h", "7h 40m", "under a minute". */
export function leftWords(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "under a minute";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h === 0 ? `${m}m` : m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** The chip's word: the mode, with how long Auto has left when it ends of itself. */
export function modeLabel(mode: ChatMode, now: number): string {
  const live = liveMode(mode, now);
  if (live.mode === "ask") return "Ask";
  if (live.until === "task") return "Auto · this task";
  return typeof live.until === "number" ? `Auto · ${leftWords(live.until - now)}` : "Auto";
}

/** What each mode does, for the chip's tooltip and the menu. */
export const MODE_WORDS: Record<ChatModeName, { label: string; does: string; short: string }> = {
  ask: {
    label: "Ask",
    does: "KOS asks you before anything risky in this chat.",
    short: "Asks you before anything risky",
  },
  auto: {
    label: "Auto",
    does: "KOS goes ahead without asking for risky steps you start in this chat, in its own browser, your Chrome and your Mac too. Each one is in the Inbox as approved by auto mode.",
    short: "Goes ahead without asking; each step is in the Inbox",
  },
};

/** The tooltip on the chip: the mode, what it does, and how to change it. */
export function modeTip(mode: ChatMode, now: number): string {
  const live = liveMode(mode, now);
  const change = live.mode === "auto" ? "Press for Ask; more in the menu." : "Press to choose a mode.";
  return `${modeLabel(live, now)}: ${MODE_WORDS[live.mode].does} ${change}`;
}

/** What Auto never covers: it asks as Ask does, or refuses, whatever the chat is set to. Enforced in the harness. */
export const AUTO_NEVER: readonly string[] = [
  "Anything KOS refuses outright; Stop and the kill switch always win, and the kill switch turns Auto off",
  "Secrets, and any step marked to ask every time",
  "Purchases and payments: paying tools, and steps on a checkout or card page",
  "Deleting for good: a whole folder, a destructive command, a permanent delete, or a delete outside the workspace",
  "A shell command past reading, building and testing, and any shell or Python run where nothing narrower than the container holds the network",
  "Writing into another project or a blob's folder, or the whole workspace from one",
  "Messages, posts, reactions and roles anyone but you sees, data sent to a site you have not listed, and opening a place to others",
  "Changing KOS itself or what runs without you: a skill, a module, an app, a site, a schedule, a coding agent",
  "Running script in a page, or handing a page to you",
  "Typing where a computer reported a password field",
  "Anything but your own words in this chat: a schedule, a guest, work another chat passed on",
  "A device's own ask for a session, and its time limits",
];

/** The sessions setting, as the menu says it. */
export const AUTO_SESSIONS = {
  label: "Start sessions too",
  hint: "On a Mac or Chrome that leaves its sessions to KOS. One that asks on itself still asks there.",
} as const;

/** The name an auto-approved call is decided by, in the audit and the Inbox. */
export const AUTO_DECIDER = "auto mode";
