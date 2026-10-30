/**
 * One session in the owner's Chrome: what the owner allowed, which tabs are
 * its, and whether the owner has taken over.
 *
 * KOS's own clicks and keys reach a page as real input, as the owner's do,
 * so the page cannot tell them apart. The extension can: it remembers each
 * of KOS's for a moment, and input the page reports that is not one of
 * them is the owner's hand, which takes the tab over.
 */

export type EndReason = "owner" | "expired" | "idle" | "detached" | "host";

export interface SessionInfo {
  id: string;
  task: string;
  requester: string;
  conversation?: string;
  /** When it ends, epoch ms. */
  until: number;
}

/** Input as the page saw it. */
export interface PageInput {
  type: "pointerdown" | "keydown" | "wheel";
  x?: number;
  y?: number;
  key?: string;
}

interface Dispatched {
  at: number;
  type: PageInput["type"];
  x?: number;
  y?: number;
  key?: string;
}

/** How long KOS's own input is remembered, to be told from the owner's. */
const ECHO_MS = 1_500;
/** How far, in CSS pixels, the page's report of a click may be from where KOS aimed it. */
const ECHO_SLACK = 2;

export class Session {
  /** Tabs that are the session's: the ones it opened, and the ones the owner handed it. */
  readonly tabs = new Set<number>();
  paused = false;
  private lastCall: number;
  private readonly echoes: Dispatched[] = [];

  constructor(
    readonly info: SessionInfo,
    now: number,
  ) {
    this.lastCall = now;
  }

  touch(now: number): void {
    this.lastCall = now;
  }

  /** Why the session is over at `now`, if it is. */
  over(now: number, idleMs: number): EndReason | undefined {
    if (now >= this.info.until) return "expired";
    if (now - this.lastCall >= idleMs) return "idle";
    return undefined;
  }

  /** A command KOS sent a tab: its input remembered, so the page's report of it is known for KOS's. */
  dispatching(method: string, params: Record<string, unknown>, now: number): void {
    this.prune(now);
    const num = (k: string): number | undefined => (typeof params[k] === "number" ? (params[k] as number) : undefined);
    if (method === "Input.dispatchMouseEvent") {
      const type = params["type"] === "mousePressed" ? "pointerdown" : params["type"] === "mouseWheel" ? "wheel" : undefined;
      if (type) this.echoes.push({ at: now, type, ...(num("x") !== undefined ? { x: num("x")! } : {}), ...(num("y") !== undefined ? { y: num("y")! } : {}) });
    } else if (method === "Input.dispatchKeyEvent" && (params["type"] === "keyDown" || params["type"] === "rawKeyDown") && typeof params["key"] === "string") {
      this.echoes.push({ at: now, type: "keydown", key: params["key"] });
    }
  }

  /** Whether input the page saw was the owner's: none of KOS's own matches it. */
  isOwners(input: PageInput, now: number): boolean {
    this.prune(now);
    const i = this.echoes.findIndex(
      (e) =>
        e.type === input.type &&
        (input.type === "keydown"
          ? e.key === input.key
          : e.x !== undefined && e.y !== undefined && input.x !== undefined && input.y !== undefined && Math.abs(e.x - input.x) <= ECHO_SLACK && Math.abs(e.y - input.y) <= ECHO_SLACK),
    );
    if (i < 0) return true;
    this.echoes.splice(i, 1);
    return false;
  }

  private prune(now: number): void {
    while (this.echoes.length && now - this.echoes[0]!.at > ECHO_MS) this.echoes.shift();
  }
}
