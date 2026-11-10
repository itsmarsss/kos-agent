import { keep, frameOf, picturesOf, type Pictured } from "./frames.js";
import type { ConsentRequest } from "./worker.js";

/**
 * The side panel's chat as KOS tells it: what it shows, what is on its way,
 * and the turn on the go, each call from KOS folded into the chat as it
 * stood. Kept apart from the panel's drawing so every call can be tried on
 * its own.
 */

/** What the owner quoted with their words, and where from: a page's address once sent, its site while selected. */
export interface Quote {
  text: string;
  from: string;
}

export type Line =
  | { role: "you"; text: string; files?: string[]; quote?: Quote }
  | { role: "kos"; text: string }
  | { role: "note"; text: string }
  | { role: "steps"; steps: Step[] };

/** A step of a turn, with the frame id of what it saw when it kept a picture. */
export interface Step {
  summary: string;
  failed?: true;
  frame?: number;
}

export interface Approval {
  id: string;
  /** The chat it is asked in, as KOS says: what keeps it up once that chat is shown. */
  chat?: string;
  tool: string;
  args?: string;
  /** Every action a step said by its purpose takes, which the arguments, cut to fit, may not reach. */
  mechanics?: string;
  why?: string;
  reason?: string;
  /** What a remembered yes covers, as its button says it ("Always on shop.example"), when it can be remembered. */
  always?: string;
  /** When it lapses if nobody decides, epoch ms. */
  expiresAt?: number;
}

/** Something said in the chat's run that is not in its words, kept after the exchange it came in. */
export interface Extra {
  after: number;
  text: string;
  /** The owner's words it is about, when KOS says: it goes under them, wherever they are. */
  said?: string;
  from?: string;
  /** A turn held on the owner: true until the chat moves on. */
  waiting?: true;
}

export interface Chat {
  conversation: string | null;
  title: string;
  lines: Line[];
  /** The owner's words on their way, until the chat has them. */
  sending: string[];
  /** The story of each turn on the go, under the words it is about: one running, and one said meanwhile. */
  stories: Extra[];
  working: boolean;
  /** The words of the turn KOS last took, and when: a turn queued behind another starts its own clock. */
  taken?: { said: string; at: number };
  extras: Extra[];
  asks: Approval[];
  consent?: ConsentRequest;
  /** Words a failed turn never took, back for the owner to send again. */
  unsent?: string;
  /** This chat acts in the owner's Chrome without asking each step. */
  auto: boolean;
  /** The steps' pictures, by frame id: sent as each step ran, and with the chat as it stands. */
  pictures: Map<number, Pictured>;
  /** The pictures of each turn on the go, by the owner's words it is about. */
  live: { said?: string; frames: number[] }[];
  /** What KOS says the chat waits on: the owner allowing a session, or deciding an approval. */
  waiting?: "consent" | "approval";
  /** The owner has control of the chat's session: KOS waits for them to hand it back. */
  held: boolean;
}

export const EMPTY: Chat = { conversation: null, title: "Chrome", lines: [], sending: [], working: false, extras: [], stories: [], asks: [], auto: false, pictures: new Map(), live: [], held: false };
export const STEP = "› ";
const yours = (lines: Line[]): number => lines.filter((l) => l.role === "you").length;

/** What a status may say beyond the chat's state: one with none of these says the state alone. */
const STATUS_WORDS = ["said", "taken", "story", "error", "frame"];

/**
 * A status from KOS folded into the chat: the state it says, then a step's
 * picture, the owner's words taken, or the turn's story. One about another
 * chat leaves this one as it was.
 */
export function statused(c: Chat, message: Record<string, unknown>): Chat {
  if (!isShown(c, message)) return c;
  const s = stated(c, message);
  // A step's picture, on its own: the story it belongs to is told apart.
  if (message["frame"] !== undefined) return framed(s, message);
  if (message["taken"] === true) return took(s, message);
  // The state alone: what the chat waits on, and who holds it.
  if (!STATUS_WORDS.some((k) => k in message)) return s;
  return storied(s, message);
}

/** Whether a call from KOS is about the chat shown: one it names as another chat is not. */
export function isShown(c: Chat, message: Record<string, unknown>): boolean {
  const about = message["chat"];
  return typeof about !== "string" || c.conversation === null || about === c.conversation;
}

/** The chat's state as a status says it: what it waits on, and whether the owner holds it. A status without them clears them. */
function stated(c: Chat, message: Record<string, unknown>): Chat {
  const waiting = message["waiting"] === "consent" || message["waiting"] === "approval" ? message["waiting"] : undefined;
  return { ...c, waiting, held: message["held"] === true };
}

/**
 * The chat as KOS says it stands now: the owner's words that arrived leave
 * the waiting ones, and a finished turn's steps are in the chat itself.
 * Another chat than the one shown, the first one made from none too, starts
 * afresh: nothing on its way to the last one is on its way to this. An ask
 * made in the chat now shown stays, though it came before it was: the first
 * chat's first turn can ask while the panel still shows none.
 */
export function shown(c: Chat, message: Record<string, unknown>): Chat {
  const conversation = (message["conversation"] as string | null) ?? null;
  const lines = (message["messages"] as Line[]) ?? [];
  const fresh = conversation !== c.conversation;
  const said = lines.filter((l): l is Extract<Line, { role: "you" }> => l.role === "you").map((l) => l.text);
  const sending = fresh ? [] : c.sending.filter((t) => !said.includes(t));
  const notice = message["notice"] as { text: string; from?: string; waiting?: true; said?: string } | undefined;
  // A wait said before is over once the chat is shown again: decided, or still asked in its own card.
  const kept = fresh ? [] : c.extras.filter((x) => !x.waiting);
  const extras = [
    ...kept,
    ...(notice ? [{ after: yours(lines), text: notice.text, ...(notice.said ? { said: notice.said } : {}), ...(notice.from ? { from: notice.from } : {}), ...(notice.waiting ? { waiting: true as const } : {}) }] : []),
  ];
  const answered = !sending.length && (notice !== undefined || lines.at(-1)?.role !== "you");
  return {
    ...c,
    conversation,
    title: String(message["title"] ?? "Chrome"),
    auto: message["auto"] === true,
    lines,
    sending,
    extras,
    working: sending.length > 0 || (c.working && !answered),
    pictures: keep(fresh ? new Map() : c.pictures, picturesOf(message)),
    ...(answered ? { stories: [], live: [] } : {}),
    ...(fresh ? { asks: c.asks.filter((a) => a.chat !== undefined && a.chat === conversation) } : {}),
  };
}

/** An approval to decide here, kept with the chat it is asked in; one asked in another chat than the one shown is not this one's. */
export function asked(c: Chat, message: Record<string, unknown>): Chat {
  if (!isShown(c, message)) return c;
  const chat = typeof message["chat"] === "string" ? message["chat"] : undefined;
  const approval: Approval = { ...(message["approval"] as Approval), ...(chat !== undefined ? { chat } : {}) };
  return { ...c, asks: [...c.asks.filter((a) => a.id !== approval.id), approval] };
}

/**
 * The owner's words, taken by KOS. Ones said somewhere else (on the
 * dashboard, in another Chrome) show here on their way, as if typed here,
 * and the turn on them is told as it goes. A command (/new, /stop) is never
 * in the chat's words, so it is never on its way to them: its answer is
 * all it waits for.
 */
function took(c: Chat, message: Record<string, unknown>): Chat {
  const said = typeof message["said"] === "string" ? message["said"] : undefined;
  if (!said || said.startsWith("/") || message["conversation"] !== c.conversation) return c;
  const shown = c.sending.includes(said) || awaiting(c.lines, said);
  const taken = c.taken?.said === said ? c.taken : { said, at: Date.now() };
  return { ...c, sending: shown ? c.sending : [...c.sending, said], working: true, taken };
}

/** The owner's words are the chat's latest and not yet answered: the turn on them is in the chat already. */
function awaiting(lines: Line[], said: string): boolean {
  const words = lines.flatMap((l) => (l.role === "you" ? [l.text] : []));
  return words.at(-1) === said && answeredWith(lines, words.length) < 0;
}

function storied(c: Chat, message: Record<string, unknown>): Chat {
  const story = message["story"];
  const said = typeof message["said"] === "string" ? message["said"] : undefined;
  // A failed turn: what is still waiting was never taken, and goes back to the owner.
  if (typeof message["error"] === "string") return { ...c, working: false, stories: [], live: [], sending: [], ...(c.sending.length ? { unsent: c.sending.join("\n") } : {}) };
  if (typeof story !== "string") return { ...c, working: false };
  const after = anchorOf(c, said);
  // The steps a finished turn already shows, told once more as it closed: nothing new.
  if (!c.sending.length && answeredWith(c.lines, after) >= stepsIn(story)) return c;
  const next: Extra = { after, text: story, ...(said !== undefined ? { said } : {}) };
  const others = c.stories.filter((x) => (said !== undefined ? x.said !== said : x.after !== after));
  return { ...c, working: true, stories: [...others, next] };
}

/** A step's picture as the turn takes it: kept, and shown with the story of the words it is about. */
function framed(c: Chat, message: Record<string, unknown>): Chat {
  const frame = frameOf(message);
  if (!frame || message["conversation"] !== c.conversation) return c;
  const said = typeof message["said"] === "string" ? message["said"] : undefined;
  const at = c.live.findIndex((x) => x.said === said);
  const entry = at >= 0 ? c.live[at]! : { ...(said !== undefined ? { said } : {}), frames: [] };
  const next = { ...entry, frames: [...entry.frames.filter((id) => id !== frame[0]), frame[0]] };
  return { ...c, pictures: keep(c.pictures, [frame]), live: at >= 0 ? c.live.map((x, i) => (i === at ? next : x)) : [...c.live, next] };
}

/** The owner's words in order, said and on their way: what a story or a notice is placed under. */
export const yourWords = (c: Pick<Chat, "lines" | "sending">): string[] => [...c.lines.flatMap((l) => (l.role === "you" ? [l.text] : [])), ...c.sending];

/** The exchange the owner's words began, counted from one; the latest exchange when they are not there. */
function anchorOf(c: Pick<Chat, "lines" | "sending">, said: string | undefined): number {
  const words = yourWords(c);
  const at = said !== undefined ? words.lastIndexOf(said) : -1;
  return at >= 0 ? at + 1 : words.length;
}

const stepsIn = (story: string): number => story.split("\n").filter((l) => l.startsWith(STEP)).length;

/** How many steps the exchange after the owner's n-th words shows, once KOS has answered it; -1 before. */
function answeredWith(lines: Line[], n: number): number {
  let seen = 0;
  let steps = 0;
  let answered = false;
  for (const line of lines) {
    if (line.role === "you") seen++;
    else if (seen === n && line.role === "steps") steps += line.steps.length;
    else if (seen === n && line.role === "kos") answered = true;
  }
  return answered && seen === n ? steps : -1;
}

