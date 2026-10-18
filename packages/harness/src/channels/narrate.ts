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

export class TurnNarrator {
  /** Paragraphs and steps, oldest first. */
  private readonly lines: string[] = [];
  /** What the model has said since the last step, still arriving. */
  private saying = "";
  private steps = 0;

  /** Take an event in; true when what would be shown has changed. */
  take(event: ProgressEvent): boolean {
    switch (event.kind) {
      case "delta":
        if (event.of !== "text") return false;
        this.saying += event.text;
        return event.text.trim().length > 0;
      case "tool-start":
        this.flush();
        this.lines.push(`${STEP_MARK}${event.summary}`);
        this.steps += 1;
        return true;
      case "tool-end": {
        if (!event.isError) return false;
        const last = this.lines.length - 1;
        if (last >= 0 && this.lines[last]!.startsWith(STEP_MARK)) this.lines[last] = `${this.lines[last]} (failed)`;
        return true;
      }
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

  /** The story, with what is being said now at its end; the tail when it runs long. */
  render(max = 1800): string {
    return tail([...this.lines, ...(this.saying.trim() ? [this.saying.trim()] : [])].join("\n"), max);
  }

  /**
   * The story up to its last step, for when the turn is over. What came
   * after the last step is the answer, and the answer is a message of its
   * own; left in, it would be read twice.
   */
  renderSteps(max = 1800): string {
    return tail(this.lines.join("\n"), max);
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
