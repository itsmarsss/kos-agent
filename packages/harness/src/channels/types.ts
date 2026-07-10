/**
 * Channel adapters connect KOS to messaging surfaces (Discord first, SMS later,
 * voice eventually). The agent loop is channel-agnostic: it speaks these
 * modality-neutral message shapes, and an adapter translates them to and from a
 * concrete surface.
 */

export interface InboundMessage {
  /** Adapter name that received the message, e.g. "discord". */
  channel: string;
  /** Channel-native sender id (mapped to a KOS user by the identity layer). */
  senderId: string;
  text: string;
  /**
   * Adapter-private handle (e.g. Discord Message) for reactions/edits.
   * Runtime must not inspect this; only the adapter's acknowledge() may.
   */
  native?: unknown;
}

export interface OutboundMessage {
  text: string;
}

export interface ApprovalRequest {
  /** Pending-action id from the approval queue. */
  id: string;
  /** Human-readable description of the risky action awaiting a decision. */
  text: string;
  /** Tool name (for rich surfaces / embeds). */
  tool?: string;
  /** Structured or JSON args. */
  args?: string | Record<string, unknown>;
  reason?: string | null;
}

export interface ApprovalDecision {
  id: string;
  approved: boolean;
  /** Channel-native id of whoever decided. */
  deciderId: string;
}

/**
 * Live turn presence: show progress while the agent works, then replace with
 * the final reply. Discord uses reactions + an editable status message; plain
 * adapters may no-op and let the runtime send() the reply.
 */
export interface TurnPresence {
  update(status: string): Promise<void>;
  complete(reply: string): Promise<void>;
  fail(message: string): Promise<void>;
}

export type MessageHandler = (msg: InboundMessage) => Promise<void> | void;
export type ApprovalHandler = (
  decision: ApprovalDecision,
) => Promise<void> | void;

/**
 * A messaging surface. `requestApproval` renders an approve/deny prompt (native
 * buttons on Discord, a text reply elsewhere); the decision arrives via
 * `onApproval`. Adapters are started and stopped by the harness.
 */
export interface ChannelAdapter {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(handler: MessageHandler): void;
  send(recipientId: string, msg: OutboundMessage): Promise<void>;
  requestApproval(recipientId: string, req: ApprovalRequest): Promise<void>;
  onApproval(handler: ApprovalHandler): void;
  /**
   * Optional: acknowledge an inbound message and return a presence handle so
   * the runtime can show progress and edit the final reply in place.
   */
  acknowledge?(msg: InboundMessage): Promise<TurnPresence | undefined>;
}
