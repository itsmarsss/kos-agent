import { TurnNarrator, type MessageFrom, type OutboundMessage, type ProgressEvent, type Sender } from "@kos/harness";

/**
 * A turn's story, mirrored into the Discord thread (or channel) a chat stands
 * for, as it runs.
 *
 * A turn taken on the dashboard, handed off, or dispatched by an orchestrator
 * showed on Discord only at the end: the thread sat empty until the whole
 * turn was over, then the passed-on message and the answer appeared at once,
 * and a chat the orchestrator had just created had no thread to show them in
 * at all. This drives the thread the way the DM presence drives a DM: the
 * incoming message goes up when the turn starts (the thread made on demand if
 * it is not there yet), the steps narrate in place as they happen, and the
 * answer lands when it is ready.
 *
 * Turns that came in from Discord already show there, so they are left to the
 * presence that is running them; a scheduled job posts its one result under
 * its own name and is left to the existing handler.
 */

/** A live, editable line, as the adapter's openStory returns. */
export interface Story {
  edit(text: string): Promise<void>;
  remove(): Promise<void>;
}

/** The turn:said event the host hands the mirror, so it can post the answer and finalize the story. */
export interface SaidEvent {
  conversationId: string;
  text: string;
  reply: string;
  origin: "owner" | "system";
  channel: string | null;
  resumed?: boolean;
}

export interface ThreadMirrorDeps {
  /** Where a conversation shows on the server: its bound channel or the thread made for it, or nothing yet. */
  targetFor(conversationId: string): string | undefined;
  /** The project a conversation belongs to, so a new chat's thread can be made under its channel. */
  projectOf(conversationId: string): string | undefined;
  /** Make a thread under a channel key (project:<slug>) and return its id, or nothing when that channel is not there yet. */
  ensureThread(channelKey: string, conversationId: string, title: string): Promise<string | undefined>;
  /** Told a thread was made for a conversation, so the kernel can bind it. */
  bindThread(threadId: string, conversationId: string): void;
  /** A conversation's title, for a thread's name. */
  titleOf(conversationId: string): string;
  /** Who a chat or schedule speaks as, when a message was passed on. */
  speakerFor(from: MessageFrom): Sender;
  /** The owner as a Discord speaker, for their own words; absent when they cannot be looked up. */
  ownerSender(): Promise<Sender | undefined>;
  /** Who answers from a conversation: the blob, the agent, or KOS. */
  senderFor(conversationId: string): Sender | undefined;
  /** The files that came with a message, read back for Discord; ones gone are dropped. */
  filesFor(files: { name: string; path: string }[]): NonNullable<OutboundMessage["files"]>;
  /** Post a message in a target by id. */
  postIn(target: string, msg: OutboundMessage): Promise<void>;
  /** Open a live, editable story line in a target. */
  openStory(target: string): Promise<Story | undefined>;
  now?: () => number;
  /** How often the story may be redrawn on the thread. */
  narrateEveryMs?: number;
  /** Note a mirror error, without failing the turn. */
  warn?: (message: string) => void;
}

interface Tracked {
  target: string;
  narrator: TurnNarrator;
  story?: Story;
  /** Set once openStory has been tried, so a target that cannot take a story is not asked again. */
  storyTried: boolean;
  lastDrawn: number;
}

const DEFAULT_NARRATE_EVERY_MS = 1200;

export class ThreadMirror {
  private readonly tracked = new Map<string, Tracked>();
  /** One running promise per conversation, so turn-start lands before the steps it precedes. */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(private readonly deps: ThreadMirrorDeps) {}

  /** Await every conversation's queued work. For tests and for a clean shutdown. */
  async settle(): Promise<void> {
    for (let i = 0; i < 50 && this.chains.size > 0; i++) await Promise.all([...this.chains.values()]);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Queue work for a conversation behind whatever is already running for it. */
  private run(conversationId: string, work: () => Promise<void>): Promise<void> {
    const prev = this.chains.get(conversationId) ?? Promise.resolve();
    const next = prev.then(work).catch((err) => this.deps.warn?.(err instanceof Error ? err.message : String(err)));
    this.chains.set(conversationId, next);
    void next.finally(() => {
      if (this.chains.get(conversationId) === next) this.chains.delete(conversationId);
    });
    return next;
  }

  /** A progress event from the kernel. */
  onProgress(event: ProgressEvent): void {
    const conv = event.conversationId;
    if (event.kind === "turn-start") void this.run(conv, () => this.start(event));
    else if (event.kind === "tool-start" || event.kind === "tool-end" || event.kind === "delta") void this.run(conv, () => this.step(conv, event));
    else if (event.kind === "turn-end") void this.run(conv, () => this.finish(conv));
  }

  /**
   * A turn's exchange, told to the mirror so it can post the answer and close
   * the story. Returns at once whether the mirror will handle this turn; when
   * it will not, the host does its own thing. The actual posting is queued on
   * the conversation's chain so it lands after the turn's steps.
   */
  onSaid(said: SaidEvent, fallback: () => Promise<void>): void {
    void this.run(said.conversationId, async () => {
      const t = this.tracked.get(said.conversationId);
      if (!t) {
        await fallback();
        return;
      }
      this.tracked.delete(said.conversationId);
      if (t.story) {
        const steps = t.narrator.renderSteps();
        await (steps.trim() ? t.story.edit(steps) : t.story.remove());
      }
      if (said.reply.trim()) {
        const from = this.deps.senderFor(said.conversationId);
        await this.deps.postIn(t.target, { text: said.reply, ...(from ? { from } : {}) });
      }
    });
  }

  private async start(event: Extract<ProgressEvent, { kind: "turn-start" }>): Promise<void> {
    const conv = event.conversationId;
    // A turn from Discord is already shown there; a scheduled job posts its
    // one result under its own name through the existing handler; a turn with
    // nothing to show (a system turn, no words) is not a conversation to tell.
    if (event.from === "discord" || conv.startsWith("cron:") || !event.said?.trim()) return;
    let target = this.deps.targetFor(conv);
    if (!target) {
      const slug = this.deps.projectOf(conv);
      if (!slug) return;
      target = await this.deps.ensureThread(`project:${slug}`, conv, this.deps.titleOf(conv));
      if (!target) return;
      this.deps.bindThread(target, conv);
    }
    const files = event.files?.length ? this.deps.filesFor(event.files) : [];
    const passed = event.origin?.from;
    if (passed && (passed.kind === "chat" || passed.kind === "schedule")) {
      // Passed on by a chat or a schedule: under that sender's name, the line saying only that it was passed on.
      await this.deps.postIn(target, { text: `${event.said.trim()}\n-# passed on`, from: this.deps.speakerFor(passed), ...(files.length ? { files } : {}) });
    } else {
      // The owner's own words, under their name and picture; quoted by the bot when they cannot be looked up.
      const owner = await this.deps.ownerSender();
      const text = owner ? event.said.trim() : `${event.said.trim().split("\n").map((l) => `> ${l}`).join("\n")}\n-# you, on the dashboard`;
      await this.deps.postIn(target, { text, ...(owner ? { from: owner } : {}), ...(files.length ? { files } : {}) });
    }
    this.tracked.set(conv, { target, narrator: new TurnNarrator(), storyTried: false, lastDrawn: 0 });
  }

  private async step(conv: string, event: ProgressEvent): Promise<void> {
    const t = this.tracked.get(conv);
    if (!t) return;
    if (!t.narrator.take(event) || !t.narrator.worthShowing()) return;
    if (!t.story && !t.storyTried) {
      t.storyTried = true;
      t.story = await this.deps.openStory(t.target);
    }
    if (!t.story) return;
    // Drawn on the leading edge of the interval; the finishing redraw catches
    // whatever a skipped edit missed, so no timer is needed.
    const now = this.now();
    if (now - t.lastDrawn < (this.deps.narrateEveryMs ?? DEFAULT_NARRATE_EVERY_MS)) return;
    t.lastDrawn = now;
    await t.story.edit(t.narrator.render());
  }

  /**
   * The turn ended. onSaid usually ran first (it fires before turn-end) and
   * cleared the record; this closes a story left open by a turn that said
   * nothing.
   */
  private async finish(conv: string): Promise<void> {
    const t = this.tracked.get(conv);
    if (!t) return;
    this.tracked.delete(conv);
    if (t.story) {
      const steps = t.narrator.renderSteps();
      await (steps.trim() ? t.story.edit(steps) : t.story.remove());
    }
  }
}
