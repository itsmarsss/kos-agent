import { runAgent, type Inference } from "../agent/loop.js";
import type { Attachment } from "../kernel/attachments.js";
import type { ToolRegistry } from "../agent/registry.js";
import { SingleOwnerMapping, type UserMapping } from "./identity.js";
import type {
  ApprovalDecision,
  ChannelAdapter,
  InboundMessage,
  OutboundMessage,
  TurnPresence,
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
}

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

  constructor(options: ChannelRuntimeOptions) {
    this.adapter = options.adapter;
    this.handleTurn = options.handleTurn;
    this.handleDecision = options.handleDecision;
    this.identity = options.identity ?? new SingleOwnerMapping();
    this.errorReply =
      options.errorReply ?? "Something went wrong handling that.";
    this.onRejected = options.onRejected ?? logRejectedInbound;
  }

  async start(): Promise<void> {
    this.adapter.setAuthorizer?.((senderId) =>
      this.resolve(this.adapter.name, senderId) !== null,
    );
    this.adapter.onMessage((msg) => this.dispatch(msg));
    if (this.handleDecision) {
      this.adapter.onApproval((decision) => this.decide(decision));
    }
    await this.adapter.start();
  }

  async stop(): Promise<void> {
    await this.adapter.stop();
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
      if (presence) {
        await presence.complete(reply);
      } else {
        await this.adapter.send(msg.senderId, reply);
      }
    } catch {
      if (presence) {
        await presence.fail(this.errorReply);
      } else {
        await this.adapter.send(msg.senderId, { text: this.errorReply });
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
