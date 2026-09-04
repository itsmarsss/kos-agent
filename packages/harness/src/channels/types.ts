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
/**
 * What a message may carry, as a contract rather than one surface's rule.
 *
 * These are Discord's numbers, and they are here rather than in the adapter
 * so the tool can tell the agent what will not fit before the adapter quietly
 * drops it. A surface with tighter limits trims further; none may promise
 * more.
 */
export const MESSAGE_LIMITS = {
  /** Buttons on one message. */
  buttons: 25,
  /** Boxes in one form. */
  modalFields: 5,
  /** Labelled values on a card. */
  cardFields: 25,
} as const;

/** One box in a form. */
export interface ModalField {
  /** Name the answer comes back under. */
  id: string;
  label: string;
  /** A line or a box. Default is a line. */
  style?: "short" | "paragraph";
  placeholder?: string;
  required?: boolean;
  /** Prefilled, for an edit rather than a blank form. */
  value?: string;
  maxLength?: number;
}

/**
 * A form the reader fills in before anything is sent.
 *
 * Buttons ask a question with a fixed set of answers. A form is for the
 * answers that are not fixed: a note, an amount, a name. Without one the only
 * way to collect that is to ask in prose and hope the reply is parseable.
 */
export interface ModalSpec {
  title: string;
  /** At most five, which is what the surface allows. */
  fields: ModalField[];
}

export interface MessageButton {
  label: string;
  id?: string;
  url?: string;
  style?: "primary" | "secondary" | "success" | "danger";
  /**
   * Open a form on press, and send what was typed rather than only the fact
   * of the press.
   */
  modal?: ModalSpec;
  /**
   * The answer to this press is for whoever pressed it and nobody else.
   *
   * Decided when the button is sent rather than when it is pressed: the
   * surface has to be told before the work starts, and by the time there is
   * an answer it is too late to make it private.
   */
  ephemeral?: boolean;
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
/**
 * Where a message goes: which surface, and where on it.
 *
 * The surface is a channel adapter by name -- discord, and whatever else is
 * connected later. Omitted means wherever the owner already is, which is the
 * ordinary case and the one that needs no thought.
 *
 * Where on it is separate, because it is the part that decides permission: a
 * message to the owner asks nothing wherever it is sent, and a message to a
 * channel is KOS speaking somewhere the owner did not pick, on any surface.
 */
export interface MessageTarget {
  /** Adapter name. Absent means whichever surface is wired. */
  surface?: string;
  /** Whom, on that surface. */
  kind: "owner" | "user" | "channel";
  /** Native id, for a user or a channel. */
  id?: string;
}

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

/**
 * How to answer a press, handed to whoever handles one.
 *
 * A surface may hold the presser waiting on a spinner, and it will not hold
 * one for long: Discord wants an acknowledgement within seconds and a real
 * answer within minutes. So answering is a sequence -- ask for the form, say
 * you are working, then say the thing -- rather than a value returned.
 */
export interface PressResponder {
  /**
   * Put a form in front of the presser and wait for it. Resolves with what
   * they typed, or undefined if they closed it or took too long.
   */
  openForm(modal: ModalSpec): Promise<Record<string, string> | undefined>;
  /**
   * Say the work has started, before doing it. Whether the answer is private
   * has to be settled here, because the surface is told at this point.
   */
  working(opts?: { ephemeral?: boolean }): Promise<void>;
  /** The answer. */
  send(msg: OutboundMessage): Promise<void>;
  /**
   * Another message into the same interaction, before the answer.
   *
   * This is the only way to reach the presser privately: a surface can make
   * an interaction response private, and cannot make an ordinary message
   * private at all. So a card sent during a press has to come through here
   * rather than as a message of its own.
   */
  followUp(msg: OutboundMessage): Promise<void>;
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
export type ButtonPressHandler = (
  press: ButtonPress,
  respond: PressResponder,
) => Promise<void> | void;

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
   * Optional: a decision was made somewhere else, so settle the prompt.
   *
   * A prompt sent here keeps its buttons until this surface is the one that
   * answers it. Decided from the dashboard, it sat there still offering a
   * choice that had already been made, and pressing it reported that the
   * action did not exist.
   */
  settleApproval?(id: string, outcome: "approved" | "denied"): Promise<void>;
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
