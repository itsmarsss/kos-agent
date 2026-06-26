/**
 * Channel adapters connect KOS to messaging surfaces (Discord first, SMS later,
 * voice eventually). The agent loop is channel-agnostic: it speaks these
 * modality-neutral message shapes, and an adapter translates them to and from a
 * concrete surface. Keeping `text` structured (rather than assuming text-only)
 * lets a voice adapter slot in without changing the core.
 */

export interface InboundMessage {
  /** Adapter name that received the message, e.g. "discord". */
  channel: string;
  /** Channel-native sender id (mapped to a KOS user by the identity layer). */
  senderId: string;
  text: string;
}

export interface OutboundMessage {
  text: string;
}

export interface ApprovalRequest {
  /** Pending-action id from the approval queue. */
  id: string;
  /** Human-readable description of the risky action awaiting a decision. */
  text: string;
}

export interface ApprovalDecision {
  id: string;
  approved: boolean;
  /** Channel-native id of whoever decided. */
  deciderId: string;
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
}
