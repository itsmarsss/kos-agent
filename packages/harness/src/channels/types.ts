import type { Attachment } from "../kernel/attachments.js";

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
   * Native thread identifier, when the surface has threads. Each key maps to
   * its own conversation, so a threaded surface needs no switch command. Leave
   * unset on a single-stream surface like a DM, where the user switches with
   * `/switch` instead.
   */
  conversationKey?: string;
  /**
   * Images and text files sent with the message. A photo of a receipt is a
   * perfectly ordinary way to tell KOS something, so a surface that drops them
   * is a surface where half of what you send goes unseen.
   */
  attachments?: Attachment[];
  /**
   * Adapter-private handle (e.g. Discord Message) for reactions/edits.
   * Runtime must not inspect this; only the adapter's acknowledge() may.
   */
  native?: unknown;
}

/**
 * A card attached to a message: a title, a body, and labelled fields.
 *
 * Modality-neutral on purpose. Discord renders it as an embed; a surface with
 * no notion of one renders the same content as text, so an agent that decides
 * to use a card does not have to know where the message is going.
 */
export interface MessageCard {
  title?: string;
  body?: string;
  url?: string;
  /** Accent colour as 0xRRGGBB, where the surface has one. */
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: string;
  imageUrl?: string;
  thumbnailUrl?: string;
}

/**
 * Something to press. `id` comes back on the press, and is the agent's own
 * name for what it means; `url` makes it a link instead, which nothing comes
 * back from.
 */
export interface MessageButton {
  label: string;
  id?: string;
  url?: string;
  style?: "primary" | "secondary" | "success" | "danger";
  /**
   * What the press comes back on, assigned by the harness rather than by
   * whoever asked for the button.
   *
   * Part of the button rather than an intersection bolted on at one call
   * site: a button travels through the reply as well as through notify, and
   * a shape the type does not admit to is one that gets dropped on the way.
   */
  token?: string;
}

export interface OutboundMessage {
  text: string;
  card?: MessageCard;
  buttons?: MessageButton[];
}

/**
 * Where a message goes.
 *
 * "owner" is the default and the only one that needs no permission: it is the
 * person KOS belongs to. Anything else is a message somewhere the owner may
 * not be watching, which is why the tool escalates it.
 */
export type MessageTarget =
  | { kind: "owner" }
  | { kind: "user"; id: string }
  | { kind: "channel"; id: string }
  /**
   * The answer to the message being handled, rather than a message of its own.
   *
   * A card sent separately arrives next to the reply as a second thing, so an
   * answer that wanted to be a card was always an answer plus a card. This
   * makes the shape part of the reply, and it asks no permission: it goes to
   * whoever is already being spoken to.
   */
  | { kind: "reply" };

/** A button that was pressed, on its way back to the conversation that sent it. */
export interface ButtonPress {
  /** The agent's own id for the button, as given when it was sent. */
  buttonId: string;
  label: string;
  /** Opaque token the runtime uses to find where the press belongs. */
  token: string;
  /** Channel-native id of whoever pressed it. */
  pressedBy: string;
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
  /**
   * The finished answer. A message rather than a string, so a turn can answer
   * with a card and buttons instead of having to send them alongside.
   */
  complete(reply: OutboundMessage): Promise<void>;
  fail(message: string): Promise<void>;
}

export type MessageHandler = (msg: InboundMessage) => Promise<void> | void;
export type ApprovalHandler = (
  decision: ApprovalDecision,
) => Promise<void> | void;
export type ButtonPressHandler = (press: ButtonPress) => Promise<void> | void;

/**
 * Is this channel-native sender allowed to talk to KOS? The runtime derives it
 * from the identity mapping; adapters only ask, never decide.
 */
export type SenderAuthorizer = (senderId: string) => boolean;

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
  /**
   * Optional: send somewhere other than a direct message to one person, which
   * for a bot on a server is most of the point of being on it. An adapter
   * without the notion refuses, and the caller is told rather than the message
   * being delivered somewhere it did not ask for.
   */
  sendTo?(target: MessageTarget, msg: OutboundMessage): Promise<void>;
  /** Optional: told when a button KOS sent was pressed. */
  onButton?(handler: ButtonPressHandler): void;
  requestApproval(recipientId: string, req: ApprovalRequest): Promise<void>;
  onApproval(handler: ApprovalHandler): void;
  /**
   * Optional: acknowledge an inbound message and return a presence handle so
   * the runtime can show progress and edit the final reply in place.
   */
  acknowledge?(msg: InboundMessage): Promise<TurnPresence | undefined>;
  /**
   * Optional: receive the authorization predicate at start, so a surface with
   * native UI (Discord buttons) can refuse an unauthorized sender before it
   * mutates any state. The runtime enforces the same check regardless.
   */
  setAuthorizer?(isAuthorized: SenderAuthorizer): void;
}
