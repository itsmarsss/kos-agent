import { runAgent, type Inference } from "../agent/loop.js";
import type { Attachment } from "../kernel/attachments.js";
import type { ProgressEvent } from "../kernel/progress.js";
import type { ToolRegistry } from "../agent/registry.js";
import { SingleOwnerMapping, type UserMapping } from "./identity.js";
import { TurnNarrator } from "./narrate.js";
import type {
  ApprovalDecision,
  ChannelAdapter,
  InboundMessage,
  OutboundMessage,
  TurnPresence,
  ApprovalOutcome,
} from "./types.js";

export interface TurnContext {
  userId: string;
  channel: string;
  senderId: string;
  text: string;
  /** Native thread id, when the surface has threads. */
  conversationKey?: string;
  /** Images and text files that came with the message. */
  attachments?: Attachment[];
}

/** Handles one user turn and returns the reply text. */
/**
 * Answers a turn. A string is the ordinary case; a message is a turn that
 * chose a shape for its answer.
 */
export type TurnHandler = (ctx: TurnContext) => Promise<string | OutboundMessage>;

export interface DecisionContext {
  /** KOS user the decider resolved to. */
  userId: string;
  channel: string;
  deciderId: string;
  /** Pending-action id from the approval queue. */
  pendingId: string;
  approved: boolean;
  remember?: boolean;
}

/** Handles an approve/deny decision that already passed the identity gate. */
export type DecisionHandler = (ctx: DecisionContext) => Promise<void> | void;

/** An inbound event from a sender the identity mapping does not recognize. */
export interface RejectedInbound {
  channel: string;
  senderId: string;
  kind: "message" | "approval";
  /** Pending-action id, for a rejected approval. */
  pendingId?: string;
}

export type RejectionLogger = (event: RejectedInbound) => void;

/** Default: record the attempt for the owner, tell the sender nothing. */
export function logRejectedInbound(event: RejectedInbound): void {
  const target = event.pendingId ? ` for pending #${event.pendingId}` : "";
  console.warn(
    `[channels] dropped ${event.kind}${target} from unauthorized ${event.channel} sender ${event.senderId}`,
  );
}

export interface ChannelRuntimeOptions {
  adapter: ChannelAdapter;
  handleTurn: TurnHandler;
  /** Approve/deny sink. Omit to leave the adapter's approval path unwired. */
  handleDecision?: DecisionHandler;
  /**
   * Sender -> KOS user, and thereby who may talk to the agent at all. Defaults
   * to SingleOwnerMapping, which trusts every sender: public surfaces must pass
   * a mapping that rejects (AllowlistMapping).
   */
  identity?: UserMapping;
  /** Reply sent when a turn throws, instead of leaking the error to the user. */
  errorReply?: string;
  /** Where unauthorized attempts are recorded. */
  onRejected?: RejectionLogger;
  /**
   * Optional: be told when an approval is decided anywhere at all.
   *
   * A prompt keeps its buttons until this surface is the one that answers it.
   * Decided from the dashboard, it sat there still offering a choice that had
   * already been made, and pressing it reported the action did not exist.
   * Returns its own unsubscribe.
   */
  watchDecisions?: (
    listener: (id: string, outcome: ApprovalOutcome) => void,
  ) => () => void;
  /**
   * Optional: follow a turn's progress as it runs, so a surface with a
   * presence can show the owner what the agent is doing before an approval
   * card lands. Returns its own unsubscribe.
   */
  watchTurn?: (ctx: TurnWatch, listener: (event: ProgressEvent) => void) => () => void;
  /** How often the story may be redrawn on the surface. */
  narrateEveryMs?: number;
}

/** Enough to find the conversation a turn will run in, before it does. */
export interface TurnWatch {
  userId: string;
  channel: string;
  conversationKey?: string;
  /** What was said, since a message addressed to an agent runs in the agent's thread. */
  text?: string;
}

const NARRATE_EVERY_MS = 1_500;

/**
 * Binds a channel adapter to a turn handler: inbound message -> resolve user ->
 * run the turn -> send (or complete presence). Channel-agnostic.
 *
 * Every inbound event passes the identity mapping first. A sender that does not
 * resolve to a user never reaches the handler, so an unknown sender cannot run
 * the agent, write memory, enter session history, or decide an approval.
 */
export class ChannelRuntime {
  private readonly adapter: ChannelAdapter;
  private readonly handleTurn: TurnHandler;
  private readonly handleDecision: DecisionHandler | undefined;
  private readonly identity: UserMapping;
  private readonly errorReply: string;
  private readonly onRejected: RejectionLogger;
  private readonly watchDecisions: ChannelRuntimeOptions["watchDecisions"];
  private readonly watchTurn: ChannelRuntimeOptions["watchTurn"];
  private readonly narrateEveryMs: number;
  private unwatch: (() => void) | undefined;

  constructor(options: ChannelRuntimeOptions) {
    this.adapter = options.adapter;
    this.handleTurn = options.handleTurn;
    this.handleDecision = options.handleDecision;
    this.identity = options.identity ?? new SingleOwnerMapping();
    this.errorReply =
      options.errorReply ?? "Something went wrong handling that.";
    this.onRejected = options.onRejected ?? logRejectedInbound;
    this.watchDecisions = options.watchDecisions;
    this.watchTurn = options.watchTurn;
    this.narrateEveryMs = options.narrateEveryMs ?? NARRATE_EVERY_MS;
  }

  async start(): Promise<void> {
    this.adapter.setAuthorizer?.((senderId) =>
      this.resolve(this.adapter.name, senderId) !== null,
    );
    this.adapter.onMessage((msg) => this.dispatch(msg));
    if (this.handleDecision) {
      this.adapter.onApproval((decision) => this.decide(decision));
    }
    /*
     * Only where the surface can settle a prompt in place. A decision this
     * surface took itself has already dropped the prompt from its own map, so
     * this settles the ones taken elsewhere and no others.
     */
    if (this.watchDecisions && this.adapter.settleApproval) {
      this.unwatch = this.watchDecisions((id, outcome) => {
        const settled = this.adapter.settleApproval?.(id, outcome);
        // A prompt that cannot be settled is not worth failing a decision over.
        if (settled) void settled.catch(() => undefined);
      });
    }
    await this.adapter.start();
  }

  async stop(): Promise<void> {
    this.unwatch?.();
    this.unwatch = undefined;
    await this.adapter.stop();
  }

  /**
   * Tell the turn's story on the surface as it goes.
   *
   * Nothing is shown until the turn takes a step: a plain answer gets no
   * extra message. A step is shown at once, so the words that led to an
   * approval are on the surface before its card; text in between is
   * redrawn at most every so often. When the turn ends the story is
   * trimmed to its steps, since the answer is a message of its own.
   */
  private narrate(presence: TurnPresence, ctx: TurnWatch): { end: () => Promise<void> } | undefined {
    if (!this.watchTurn) return undefined;
    const narrator = new TurnNarrator();
    let shownAt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last: Promise<void> = Promise.resolve();
    const show = (text: string): void => {
      shownAt = Date.now();
      last = last.then(() => presence.update(text)).catch(() => undefined);
    };
    const redraw = (now: boolean): void => {
      if (!narrator.worthShowing()) return;
      const due = this.narrateEveryMs - (Date.now() - shownAt);
      if (now || due <= 0) {
        if (timer) clearTimeout(timer);
        timer = undefined;
        show(narrator.render());
      } else if (!timer) {
        timer = setTimeout(() => {
          timer = undefined;
          show(narrator.render());
        }, due);
      }
    };
    const unwatch = this.watchTurn(ctx, (event) => {
      if (narrator.take(event)) redraw(event.kind === "tool-start");
    });
    return {
      end: async () => {
        unwatch();
        if (timer) clearTimeout(timer);
        timer = undefined;
        if (narrator.worthShowing()) show(narrator.renderSteps());
        await last;
      },
    };
  }

  private resolve(channel: string, senderId: string): string | null {
    return this.identity.resolve(channel, senderId) ?? null;
  }

  private async decide(decision: ApprovalDecision): Promise<void> {
    const channel = this.adapter.name;
    const userId = this.resolve(channel, decision.deciderId);
    if (userId === null) {
      this.onRejected({
        channel,
        senderId: decision.deciderId,
        kind: "approval",
        pendingId: decision.id,
      });
      return;
    }
    try {
      await this.handleDecision?.({
        userId,
        channel,
        deciderId: decision.deciderId,
        pendingId: decision.id,
        approved: decision.approved,
        ...(decision.remember ? { remember: true } : {}),
      });
    } catch {
      // The decision path has no reply channel of its own; never surface the
      // raw error to the surface.
      console.error(`[channels] approval #${decision.id} failed`);
    }
  }

  private async dispatch(msg: InboundMessage): Promise<void> {
    const userId = this.resolve(msg.channel, msg.senderId);
    if (userId === null) {
      // Unknown sender: drop before anything is acknowledged, so no agent run,
      // no memory write, no session history, and no workspace state echoed back.
      this.onRejected({
        channel: msg.channel,
        senderId: msg.senderId,
        kind: "message",
      });
      return;
    }
    let presence: TurnPresence | undefined;
    try {
      presence = await this.adapter.acknowledge?.(msg);
    } catch {
      presence = undefined;
    }
    const story = presence ? this.narrate(presence, { userId, channel: msg.channel, text: msg.text, ...(msg.conversationKey ? { conversationKey: msg.conversationKey } : {}) }) : undefined;

    try {
      const answer = await this.handleTurn({
        userId,
        channel: msg.channel,
        senderId: msg.senderId,
        text: msg.text,
        ...(msg.conversationKey ? { conversationKey: msg.conversationKey } : {}),
        ...(msg.attachments?.length ? { attachments: msg.attachments } : {}),
      });
      const reply: OutboundMessage =
        typeof answer === "string" ? { text: answer } : answer;
      // A turn that answered with a card and nothing else still said
      // something; only an empty one needs standing in for.
      if (!reply.text && !reply.card) reply.text = "(no reply)";
      await story?.end();
      if (presence) {
        await presence.complete(reply);
      } else {
        await this.adapter.send(msg.senderId, reply);
      }
    } catch (err) {
      // Said in the log whatever happens next: a reply lost to a surface
      // that was unreachable for a moment is otherwise a message the owner
      // never got and nobody can account for.
      console.error(
        `[channels] ${this.adapter.name}: the turn failed or its reply was not delivered`,
        err instanceof Error ? err.message : String(err),
      );
      await story?.end().catch(() => undefined);
      /*
       * Telling the owner it went wrong can itself go wrong.
       *
       * This was the last unguarded await on the path: a surface that could
       * not deliver threw out of dispatch, out of the onMessage callback, and
       * took the host down with it. There is nowhere left to report to by
       * this point, so it goes to the log and the process stays up.
       */
      try {
        if (presence) {
          await presence.fail(this.errorReply);
        } else {
          await this.adapter.send(msg.senderId, { text: this.errorReply });
        }
      } catch (err) {
        console.error(
          `[channels] ${this.adapter.name}: could not deliver a reply`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }
}

export interface AgentTurnOptions {
  system?: string;
  maxIterations?: number;
}

/**
 * Build a TurnHandler that runs the agent loop for each message and returns the
 * agent's final text.
 */
export function createAgentTurnHandler(
  inference: Inference,
  registry: ToolRegistry,
  options: AgentTurnOptions = {},
): TurnHandler {
  return async (ctx) => {
    const result = await runAgent(inference, registry, ctx.text, {
      task: "reasoning",
      ...(options.system ? { system: options.system } : {}),
      ...(options.maxIterations ? { maxIterations: options.maxIterations } : {}),
    });
    return result.finalText;
  };
}
