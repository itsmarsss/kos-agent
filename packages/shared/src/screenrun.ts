/**
 * One way to run a short sequence of actions on a screen, for every surface
 * KOS works: its own browser and the owner's Chrome (CDP, direct or through
 * the extension) and a computer (the device protocol).
 *
 * The runner owns what the surfaces share: the input shape, the order, the
 * owner's Stop between actions and inside the one in flight, one budget for
 * every wait in a call, and how a run that stops part way says so ("Done:
 * ... Step 3 (click) failed: why."). An adapter owns the rest: what an
 * action is on its surface, and doing one.
 *
 * It also keeps what each chat was last shown, so a screen that has not
 * changed since the last picture is said in words on every surface.
 */

/** The most one call waits, in all its waits together. */
export const WAIT_BUDGET_MS = 60_000;

/** What a run may come back with after it: a picture, the page as text (web), or nothing. */
export type ActThen = "look" | "snapshot" | "read" | "none";

/** The waits of one call, shared by every action in it. */
export class WaitBudget {
  constructor(private leftMs = WAIT_BUDGET_MS) {}

  /** As much of `ms` as is left, taken. */
  take(ms: number): number {
    const granted = Math.max(0, Math.min(ms, this.leftMs));
    this.leftMs -= granted;
    return granted;
  }

  get left(): number {
    return this.leftMs;
  }
}

export interface ActionContext {
  /** The owner's Stop: an adapter that can stop the action in flight listens to it. */
  signal?: AbortSignal;
  waits: WaitBudget;
  /** Where the action is in the run, from 0. */
  index: number;
}

export interface RunAdapter<A> {
  /** An action checked before any runs; throws saying what is wrong with it. */
  parse(raw: unknown, index: number): A;
  /** The action's name in a failure line: "click", "left_click". */
  name(action: A): string;
  /** Do it; what was done, in words. */
  perform(action: A, ctx: ActionContext): Promise<string>;
  /** Why an action failed, in words for the model; the error's message when absent. */
  why?(err: unknown): string;
  /** What to add to a failure, such as what the page offers now. */
  afterFailure?(): Promise<string>;
  /** A pause after each action but the last, so each lands before the next. */
  betweenMs?: number;
}

export interface RunOptions {
  signal?: AbortSignal;
  /** The longest the whole run may take. */
  deadlineMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

/** What a run did, line by line, as the start of a result. */
export function doneText(done: string[]): string {
  return done.length ? `Done: ${done.map((d) => d.replace(/\.$/, "")).join("; ")}.` : "";
}

/** A run that stopped part way: what it did, and why it stopped. */
export class RunError extends Error {
  constructor(
    readonly done: string[],
    readonly why: string,
  ) {
    super(`${doneText(done)}${done.length ? " " : ""}${why}`);
  }
}

/** Why a run stopped where the owner pressed Stop. */
export const stoppedAt = (index: number): string => `Stopped by the owner before step ${index + 1}.`;

/** A pause that ends at once when the signal aborts. */
export function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted || ms <= 0) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * The actions a call was given: `actions`, or `steps` as the browser's older
 * name for them, still taken so saved skills and prompts keep working. Both
 * at once is refused: which list would run would be a guess.
 */
export function actionsOf(input: Record<string, unknown>, max: number): unknown[] {
  const actions = input["actions"];
  const steps = input["steps"];
  if (actions !== undefined && steps !== undefined) throw new Error("give the actions as `actions` alone, not with `steps`");
  const list = actions ?? steps;
  if (!Array.isArray(list) || list.length === 0) throw new Error("actions required: a list of one or more");
  if (list.length > max) throw new Error(`at most ${max} actions in one call`);
  return list;
}

/** Whether a call was given a run of actions at all, under either name. */
export function hasActions(input: Record<string, unknown>): boolean {
  return Array.isArray(input["actions"]) || Array.isArray(input["steps"]);
}

/**
 * Actions in order. Every one is checked before the first runs, so a
 * malformed run never half-happens. Once the signal aborts no further action
 * starts, and the one in flight is told through its context; a failure stops
 * the run. Either way the error says what was done first.
 */
export async function runActions<A>(adapter: RunAdapter<A>, raw: unknown[], options: RunOptions = {}): Promise<string[]> {
  const actions = raw.map((r, i) => adapter.parse(r, i));
  const { signal } = options;
  const sleep = options.sleep ?? pause;
  const now = options.now ?? Date.now;
  const start = now();
  const waits = new WaitBudget();
  const done: string[] = [];
  for (const [index, action] of actions.entries()) {
    if (signal?.aborted) throw new RunError(done, stoppedAt(index));
    if (options.deadlineMs !== undefined && now() - start > options.deadlineMs) throw new RunError(done, `Ran out of time before step ${index + 1}.`);
    try {
      done.push(await adapter.perform(action, { ...(signal ? { signal } : {}), waits, index }));
    } catch (err) {
      if (signal?.aborted) throw new RunError(done, stoppedAt(index).replace("before", "during"));
      const why = adapter.why?.(err) ?? (err instanceof Error ? err.message : String(err));
      const more = (await adapter.afterFailure?.().catch(() => "")) ?? "";
      throw new RunError(done, `Step ${index + 1} (${adapter.name(action)}) failed: ${why.replace(/\.$/, "")}.${more}`);
    }
    if (index < actions.length - 1 && adapter.betweenMs) await sleep(adapter.betweenMs, signal);
  }
  return done;
}

/**
 * Work that the owner's Stop ends at once: the work goes on to its own end,
 * unheard, and the caller is answered now. For a transport whose call cannot
 * be taken back once sent, so a Stop is not held up by its reply.
 */
export function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("stopped by the owner"));
    const onAbort = (): void => reject(new Error("stopped by the owner"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** A short fingerprint of a picture, to tell one screen from another without keeping it. */
export function digestOf(image: string): string {
  // cyrb53 over the base64 text: quick, and two different screens all but never meet.
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < image.length; i++) {
    const c = image.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${(h2 >>> 0).toString(16)}${(h1 >>> 0).toString(16)}:${image.length}`;
}

/** What a chat is told in place of a picture of a screen that has not changed. */
export const UNCHANGED = "The screen has not changed since your last picture.";

/**
 * The last picture each chat was shown. Watching a slow job sent the same
 * picture again and again, each read whole by the model; a screen that has
 * not changed is said in words instead. A chat starting afresh (a turn, a
 * fresh query) has not seen the last one, so it is forgotten then.
 */
export class ScreenMemory {
  private readonly shown = new Map<string, string>();

  /** True when this is the picture the chat was last shown; otherwise it is remembered as shown. */
  unchanged(chat: string, image: string): boolean {
    const digest = digestOf(image);
    if (this.shown.get(chat) === digest) return true;
    this.shown.set(chat, digest);
    return false;
  }

  /** The picture is sent whatever: remembered as the last shown. */
  showing(chat: string, image: string): void {
    this.shown.set(chat, digestOf(image));
  }

  forget(chat: string): void {
    this.shown.delete(chat);
  }
}
