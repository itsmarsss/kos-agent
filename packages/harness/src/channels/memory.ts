import type {
  ApprovalDecision,
  ApprovalHandler,
  ApprovalRequest,
  ChannelAdapter,
  InboundMessage,
  MessageHandler,
  OutboundMessage,
} from "./types.js";

export interface SentMessage {
  recipientId: string;
  msg: OutboundMessage;
}

export interface SentApproval {
  recipientId: string;
  req: ApprovalRequest;
}

/**
 * An in-process channel adapter for tests and local wiring. It records what was
 * sent and lets a test inject inbound messages and approval decisions, so the
 * channel-agnostic runtime can be exercised end to end without a real surface.
 */
export class InMemoryAdapter implements ChannelAdapter {
  readonly name = "memory";
  readonly sent: SentMessage[] = [];
  readonly approvalsRequested: SentApproval[] = [];

  private messageHandler?: MessageHandler;
  private approvalHandler?: ApprovalHandler;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  onApproval(handler: ApprovalHandler): void {
    this.approvalHandler = handler;
  }

  async send(recipientId: string, msg: OutboundMessage): Promise<void> {
    this.sent.push({ recipientId, msg });
  }

  async requestApproval(
    recipientId: string,
    req: ApprovalRequest,
  ): Promise<void> {
    this.approvalsRequested.push({ recipientId, req });
  }

  /** Test helper: simulate an inbound message from the surface. */
  async receive(msg: InboundMessage): Promise<void> {
    await this.messageHandler?.(msg);
  }

  /** Test helper: simulate an approval decision from the surface. */
  async decide(decision: ApprovalDecision): Promise<void> {
    await this.approvalHandler?.(decision);
  }
}
