import type { PageSpot } from "../tools/browser.js";

/** How recent the agent's last picture of its page must be to stand for it in an approval. */
const FRESH_MS = 30_000;
/** Conversations whose last picture is kept, at most. */
const KEPT = 16;

interface Seen {
  picture: string;
  at: number;
  spot: PageSpot;
  site: string | undefined;
}

/**
 * Each conversation's last picture of its page, to show in an approval in
 * place of another taken on the same line to the tab. It stands for the page
 * only while nothing could have changed it since: the same tab at the same
 * address, nothing moved under it (a navigation, the owner taking it or
 * letting it go), the same site trusted, no other browser call of that
 * conversation running, and taken a moment ago.
 */
export class SeenPages {
  private readonly seen = new Map<string, Seen>();
  /** The picture set aside as a call began, which a look that found the screen unchanged vouches for again. */
  private readonly held = new Map<string, Seen>();
  private readonly running = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** A browser call of the conversation begins to run: what was seen before may not be so now. The answer is called when it ends. */
  run(conversation: string): () => void {
    const before = this.seen.get(conversation);
    if (before) this.held.set(conversation, before);
    this.seen.delete(conversation);
    this.running.set(conversation, (this.running.get(conversation) ?? 0) + 1);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const left = (this.running.get(conversation) ?? 1) - 1;
      if (left > 0) this.running.set(conversation, left);
      else this.running.delete(conversation);
    };
  }

  /** The picture a browser call answered with, where its page was; kept only when no other call of the conversation is still running. */
  saw(conversation: string, picture: string, spot: PageSpot | undefined, site: string | undefined): void {
    this.forget(conversation);
    if (!spot || this.running.has(conversation)) return;
    this.seen.set(conversation, { picture, at: this.now(), spot, site });
    if (this.seen.size > KEPT) this.seen.delete(this.seen.keys().next().value!);
  }

  /** A browser call answered without a picture: the page may have changed, and the last one no longer stands for it. */
  forget(conversation: string): void {
    this.seen.delete(conversation);
    this.held.delete(conversation);
  }

  /**
   * A browser call looked and found the screen as the last picture showed it,
   * so it answered with words and no picture: that picture stands again,
   * taken now, but only where it was taken.
   */
  still(conversation: string, spot: PageSpot | undefined, site: string | undefined): void {
    const before = this.held.get(conversation);
    this.held.delete(conversation);
    if (!before || !spot || this.running.has(conversation) || !sameSpot(before, spot, site)) return;
    this.seen.set(conversation, { ...before, at: this.now() });
  }

  /** The last picture, if it still stands for the page where the conversation's tab is now. */
  picture(conversation: string, spot: PageSpot | undefined, site: string | undefined): string | undefined {
    const seen = this.seen.get(conversation);
    if (!seen || !spot || this.running.has(conversation) || this.now() - seen.at >= FRESH_MS) return undefined;
    return sameSpot(seen, spot, site) ? seen.picture : undefined;
  }
}

function sameSpot(seen: Seen, spot: PageSpot, site: string | undefined): boolean {
  return seen.spot.tab === spot.tab && seen.spot.url === spot.url && seen.spot.moved === spot.moved && seen.site === site;
}
