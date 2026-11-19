import type { ProgressEvent } from "../kernel/progress.js";

/**
 * The story of a turn so far, told from its progress events.
 *
 * A surface that can edit one message in place can show the owner what
 * the agent is doing as it does it: the sentences it says between steps,
 * and the steps themselves. The point is order. An approval card that
 * lands with nothing before it is a prompt to click yes blind; the same
 * card after "I'll clear the build folder so the rebuild is clean" is a
 * decision. Surface-neutral: a step is a line that starts with "› ", and
 * the surface draws it how it likes.
 */

/** Marks a step line, so a surface can set it apart from the agent's words. */
export const STEP_MARK = "› ";
/**
 * Ends a step line that finished, after its time: KOS for Chrome and KOS for
 * Mac read the story's lines by these marks, so a line ends with one.
 */
export const DONE_MARK = " (done)";
/** Ends a step line that failed. */
export const FAILED_MARK = " (failed)";
/** The step a turn carried on in a fresh query takes first: a look at the screen again. */
export const LOOKING_AGAIN = "Looking again";
/** Said on the step a turn is held on while the owner decides. */
export const WAITING_ON_YOU = "waiting on you";

/** How long, as a step line says it: "0.4s", "12s", "2m 05s", "1h 02m". */
export function durationWords(ms: number): string {
  if (ms < 10_000) return `${Math.max(0.1, Math.round(ms / 100) / 10).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

const DURATION = String.raw`(?:\d+\.\d+s|\d+s|\d+m \d{2}s|\d+h \d{2}m)`;
/** A step line still at work: its time so far, or its wait on the owner, can still change. */
export const RUNNING_STEP = new RegExp(String.raw` · (?:${DURATION} so far|${WAITING_ON_YOU})$`);
/** The time a step line ends with: how long it ran or has run so far, its wait for the owner, or that it waits now. */
const STEP_TIME = new RegExp(String.raw`(?: · (?:${DURATION}(?: so far)?|${WAITING_ON_YOU}))?(?: · waited ${DURATION} for you)?$`);

/** A step line as what it did and when: the time it ends with set apart, so like steps fold whatever each took. */
export function stepParts(line: string): { what: string; time: string } {
  // A failed step stays apart from the same step done: its mark is part of what it did.
  const failed = line.endsWith(FAILED_MARK);
  const bare = failed ? line.slice(0, -FAILED_MARK.length) : line;
  const m = STEP_TIME.exec(bare);
  const what = m && m[0] ? bare.slice(0, m.index) : bare;
  return { what: failed ? `${what}${FAILED_MARK}` : what, time: m?.[0] ?? "" };
}

interface Step {
  summary: string;
  tool: string;
  /** When it began, epoch ms. */
  startedAt: number;
  /** How long it ran, once it ended. */
  ms?: number;
  waitedMs?: number;
  failed?: boolean;
}

export class TurnNarrator {
  /** Paragraphs and steps, oldest first: a step's line is drawn from its record. */
  private readonly lines: (string | Step)[] = [];
  /** What the model has said since the last step, still arriving. */
  private saying = "";
  private steps = 0;
  /** The steps still running, oldest first; a look again has no tool and ends at the next step. */
  private running: Step[] = [];
  /** The turn is held on the owner's decision. */
  private held = false;
  /** The newest picture a step took, by frame id. */
  private frame: number | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  /** Take an event in; true when what would be shown has changed. */
  take(event: ProgressEvent): boolean {
    switch (event.kind) {
      case "delta":
        if (event.of !== "text") return false;
        this.saying += event.text;
        return event.text.trim().length > 0;
      case "tool-start":
        this.held = false;
        this.end("");
        this.step(event.summary, event.tool, event.at);
        return true;
      case "tool-end":
        this.held = false;
        return this.end(event.tool, event);
      case "fresh":
        this.end("");
        this.step(LOOKING_AGAIN, "");
        return true;
      case "frame":
        if (this.frame === event.frameId) return false;
        this.frame = event.frameId;
        return true;
      case "turn-end":
        // What is being said as the turn ends is the answer, and the answer
        // is a message of its own. Flushed into the lines it was read twice:
        // once in the story, once as the reply under it.
        return false;
      default:
        return false;
    }
  }

  /** Nothing is worth a message until the turn has taken a step. */
  worthShowing(): boolean {
    return this.steps > 0;
  }

  /** Whether a step is at work, so its time so far is worth redrawing. */
  ticking(): boolean {
    return !this.held && this.running.some((s) => s.tool !== "");
  }

  /** The turn is held on the owner's decision: its running step says so until the next event. */
  waiting(): void {
    this.held = true;
  }

  /** The newest picture a step took, by frame id. */
  picture(): number | undefined {
    return this.frame;
  }

  /** The story, with what is being said now at its end; the tail when it runs long. */
  render(max = 1800): string {
    return tail([...this.drawn(), ...(this.saying.trim() ? [this.saying.trim()] : [])].join("\n"), max);
  }

  /**
   * The story up to its last step, for when the turn is over. What came
   * after the last step is the answer, and the answer is a message of its
   * own; left in, it would be read twice.
   */
  renderSteps(max = 1800): string {
    return tail(this.drawn().join("\n"), max);
  }

  private drawn(): string[] {
    return this.lines.map((l) => (typeof l === "string" ? l : this.stepLine(l)));
  }

  /** A step as its line: what it does, then how long it took or has taken, and its wait for the owner. */
  private stepLine(step: Step): string {
    const head = `${STEP_MARK}${step.summary}`;
    if (step.ms === undefined) {
      if (this.held && step.tool !== "") return `${head} · ${WAITING_ON_YOU}`;
      const so = this.now() - step.startedAt;
      return so >= 1000 && step.tool !== "" ? `${head} · ${durationWords(so)} so far` : head;
    }
    // Under a second is not worth saying; a wait for the owner always is.
    const took = step.tool !== "" && step.ms >= 1000 ? ` · ${durationWords(step.ms)}` : "";
    const waited = step.waitedMs !== undefined && step.waitedMs >= 1000 ? ` · waited ${durationWords(step.waitedMs)} for you` : "";
    return `${head}${took}${waited}${step.failed ? FAILED_MARK : DONE_MARK}`;
  }

  private step(summary: string, tool: string, at?: number): void {
    this.flush();
    const step: Step = { summary, tool, startedAt: at ?? this.now() };
    this.running.push(step);
    this.lines.push(step);
    this.steps += 1;
  }

  /** The latest running step of this tool, ended; false when none was running. */
  private end(tool: string, event?: Extract<ProgressEvent, { kind: "tool-end" }>): boolean {
    let i = this.running.length - 1;
    while (i >= 0 && this.running[i]!.tool !== tool) i -= 1;
    if (i < 0) return false;
    const step = this.running.splice(i, 1)[0]!;
    // How long it ran, without the wait for the owner's yes.
    step.ms = event?.ms ?? Math.max(0, this.now() - step.startedAt - (event?.waitedMs ?? 0));
    if (event?.waitedMs !== undefined) step.waitedMs = event.waitedMs;
    if (event?.isError) step.failed = true;
    return true;
  }

  private flush(): void {
    const said = this.saying.trim();
    if (said) this.lines.push(said);
    this.saying = "";
  }
}

function tail(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(-max);
  const atLine = cut.indexOf("\n");
  return `…${atLine > 0 && atLine < 120 ? cut.slice(atLine + 1) : cut}`;
}

/** How many step lines a short story keeps; the ones before are counted. */
const KEEP_STEPS = 8;
/** A step line longer than this is cut, so eight of them stay well inside a message. */
const STEP_LINE_MAX = 160;

/**
 * A story short enough to read at a glance, for a surface that redraws one
 * message: a run of the same step is one line with "×N", a step that runs
 * long is cut, and only the last few steps are kept, the ones before
 * counted where they were. The agent's own words are all kept, wherever
 * they fall: "I'm going to delete the old builds" is the line the owner
 * most needs, and steps are what fold and cap, not what was said. A story
 * that came already cut ("…") counts its earlier steps as at least so many.
 */
export function shortStory(story: string, keep = KEEP_STEPS): string {
  const cut = story.startsWith("…");
  const lines: { text: string; time: string; times: number; step: boolean }[] = [];
  for (const told of (cut ? story.slice(1) : story).split("\n")) {
    // A line redrawn as one message has no room for which steps finished: the last one is the one at work.
    const line = told.startsWith(STEP_MARK) && told.endsWith(DONE_MARK) ? told.slice(0, -DONE_MARK.length) : told;
    // Folded on what the step did, its whole line before any of it is cut
    // (two fills that share their first hundred and sixty characters are two
    // fills), whatever each took: the time shown is the last one's.
    const step = line.startsWith(STEP_MARK);
    const { what, time } = step ? stepParts(line) : { what: line, time: "" };
    const last = lines[lines.length - 1];
    if (last && step && last.step && last.text === what) {
      last.times += 1;
      last.time = time;
    } else lines.push({ text: what, time, times: 1, step });
  }
  const steps = lines.filter((l) => l.step);
  const first = steps.length > keep ? lines.indexOf(steps[steps.length - keep]!) : 0;
  const out: string[] = [];
  let dropped = 0;
  // Before a story that came cut there were steps nobody counted.
  let uncounted = cut;
  const count = (): void => {
    if (dropped || uncounted) {
      const n = dropped ? `${dropped}${uncounted ? "+" : ""} earlier step${dropped === 1 && !uncounted ? "" : "s"}` : "Earlier steps";
      out.push(`${STEP_MARK}${n}`);
    }
    dropped = 0;
    uncounted = false;
  };
  for (const [i, l] of lines.entries()) {
    if (i < first && l.step) {
      dropped += l.times;
      continue;
    }
    count();
    const text = l.step && l.text.length > STEP_LINE_MAX ? `${l.text.slice(0, STEP_LINE_MAX - 1)}…` : l.text;
    out.push(`${l.times > 1 ? `${text} ×${l.times}` : text}${l.time}`);
  }
  count();
  return out.join("\n");
}
