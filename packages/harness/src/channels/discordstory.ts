import type { StoryExtra } from "./types.js";

/**
 * One turn's story on Discord: a message that edits itself as the steps
 * run, rolling onto a new message when it outgrows one.
 *
 * Edits are coalesced: one is in flight at a time, at most one every
 * `gapMs`, and whatever came while one was in flight is drawn next as the
 * newest state alone, never as a backlog of every state in between. A
 * rate limit Discord answers with is waited out the same way. The newest
 * step's picture rides as the message's thumbnail, sent again only when it
 * changes.
 */

/** What a story message is edited with. */
export interface StoryPayload {
  content: string;
  embeds?: { thumbnail: { url: string } }[];
  files?: { attachment: Buffer; name: string }[];
  /** Kept attachments: none, so a new picture replaces the old. */
  attachments?: never[];
}

/** A story message as posted. */
export interface StoryPost {
  edit(payload: StoryPayload): Promise<unknown>;
  remove(): Promise<unknown>;
}

export interface LiveStoryOptions {
  /** The words as Discord takes them. */
  render: (raw: string) => string;
  /** Post the next message, when the story outgrows this one. */
  next: (content: string) => Promise<StoryPost | undefined>;
  /** Whether a picture may show where the story is told: the owner's alone. */
  pictures?: boolean;
  gapMs?: number;
  /** Discord's limit is 2000; a little is kept for the Auto mark. */
  limit?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Discord allows about five edits of a message in five seconds. */
const GAP_MS = 1_100;
const LIMIT = 1_900;
const PICTURE = "step.jpg";

/** A rate limit as discord.js reports one it was told to give up on: how long to wait. */
function retryAfter(err: unknown): number | undefined {
  const e = err as { name?: string; status?: number; retryAfter?: number; timeToReset?: number } | null;
  if (!e) return undefined;
  if (e.name !== "RateLimitError" && e.status !== 429) return undefined;
  return e.retryAfter ?? e.timeToReset ?? 1_000;
}

/** The Auto mark at the start of a story's message: inside its first small line when it opens with one. */
export function autoMarked(content: string): string {
  return content.startsWith("-# ") ? `-# (Auto) ${content.slice(3)}` : `(Auto) ${content}`;
}

/** A step line that is still running: the story is not rolled past one, so its time can still change. */
const RUNNING = / · (?:\S+ so far|waiting on you)$/;

export class LiveStory {
  private readonly posts: StoryPost[];
  /** How many of the story's lines are in the messages before the last, settled there. */
  private settled = 0;
  private wanted?: { raw: string; extra: StoryExtra };
  private drawing?: Promise<void>;
  private lastAt = Number.NEGATIVE_INFINITY;
  private shownPicture?: number;
  private readonly gapMs: number;
  private readonly limit: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    first: StoryPost,
    private readonly options: LiveStoryOptions,
  ) {
    this.posts = [first];
    this.gapMs = options.gapMs ?? GAP_MS;
    this.limit = options.limit ?? LIMIT;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Draw the story as it now stands; resolves once it is drawn, or a newer state has replaced it. */
  update(raw: string, extra: StoryExtra = {}): Promise<void> {
    this.wanted = { raw, extra };
    this.drawing ??= this.drain().finally(() => {
      this.drawing = undefined;
    });
    return this.drawing;
  }

  /** Every message of the story, taken down. */
  async remove(): Promise<void> {
    this.wanted = undefined;
    await this.drawing;
    await Promise.all(this.posts.map((p) => p.remove().catch(() => undefined)));
  }

  private async drain(): Promise<void> {
    while (this.wanted) {
      const wait = this.lastAt + this.gapMs - this.now();
      if (wait > 0) await this.sleep(wait);
      const next = this.wanted;
      this.wanted = undefined;
      if (!next) break;
      try {
        await this.draw(next.raw, next.extra);
      } catch (err) {
        // Held by Discord: waited out, and the newest state drawn after.
        const hold = retryAfter(err);
        if (hold !== undefined) {
          this.wanted ??= next;
          this.lastAt = this.now() + hold - this.gapMs;
          continue;
        }
      }
      this.lastAt = this.now();
    }
  }

  private content(lines: string[], extra: StoryExtra): string {
    const text = this.options.render(lines.join("\n"));
    return extra.auto && text.trim() ? autoMarked(text) : text;
  }

  private async draw(raw: string, extra: StoryExtra): Promise<void> {
    const lines = raw.split("\n");
    // Outgrown: the lines that fit stay in this message, settled, and the
    // rest go on in a new one. Never past a step still running.
    for (;;) {
      const open = lines.slice(this.settled);
      if (this.content(open, extra).length <= this.limit || open.length <= 1) break;
      let fit = 1;
      while (fit < open.length - 1 && this.content(open.slice(0, fit + 1), extra).length <= this.limit) fit += 1;
      const running = open.findIndex((l) => RUNNING.test(l));
      if (running > 0 && running < fit) fit = running;
      await this.posts.at(-1)!.edit({ content: this.content(open.slice(0, fit), extra).slice(0, 2000), embeds: [], attachments: [] });
      this.shownPicture = undefined;
      this.settled += fit;
      const post = await this.options.next(this.content(lines.slice(this.settled), extra).slice(0, 2000));
      if (!post) return;
      this.posts.push(post);
    }
    const content = this.content(lines.slice(this.settled), extra).slice(0, 2000);
    if (!content.trim()) return;
    const picture = this.options.pictures ? extra.picture : undefined;
    const fresh = picture && picture.id !== this.shownPicture ? picture : undefined;
    await this.posts.at(-1)!.edit({
      content,
      ...(fresh
        ? { embeds: [{ thumbnail: { url: `attachment://${PICTURE}` } }], files: [{ attachment: Buffer.from(fresh.image, "base64"), name: PICTURE }], attachments: [] }
        : {}),
    });
    if (fresh) this.shownPicture = fresh.id;
  }
}
