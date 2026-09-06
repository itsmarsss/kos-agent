import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { ThreadReader, type ThreadMessage } from "./imessagedb.js";
import type {
  ApprovalHandler,
  ApprovalRequest,
  ChannelAdapter,
  MessageHandler,
  OutboundMessage,
  SenderAuthorizer,
} from "./types.js";

/**
 * iMessage, as one thread the owner talks to themselves in.
 *
 * The surface has none of Discord's furniture: no embeds, no buttons, no
 * editing a message once sent, nothing private. So a card becomes text and an
 * approval becomes a sentence with two words that answer it. Rendering down is
 * the adapter's whole job here, and the runtime above it does not change.
 *
 * Reading is confined by ThreadReader to a single handle. See that file for
 * why that matters more here than anywhere else in KOS.
 */

const run = promisify(execFile);

/** How KOS marks its own messages, so it does not read them back as input. */
const ECHO_WINDOW_MS = 5 * 60_000;

export interface IMessageOptions {
  /**
   * The owner's own handle: the note-to-self thread, and the only
   * conversation this adapter reads or writes.
   */
  handle: string;
  /** Path to chat.db. */
  dbPath: string;
  /** How often to look, in ms. */
  pollMs?: number;
  /**
   * How a message is actually sent. Injected so a test never drives
   * Messages.app, and so a host without it can supply its own transport.
   */
  sender?: (handle: string, text: string) => Promise<void>;
  now?: () => number;
}

/**
 * Hand a message to Messages.app.
 *
 * The text goes in as an argument rather than being pasted into the script,
 * because a message is arbitrary text the owner or the agent wrote and
 * building a script around it is how a quote mark becomes an instruction.
 */
export async function sendViaMessages(
  handle: string,
  text: string,
): Promise<void> {
  const script = `
on run argv
  set targetHandle to item 1 of argv
  set body to item 2 of argv
  tell application "Messages"
    set svc to 1st account whose service type = iMessage
    set buddy to participant targetHandle of svc
    send body to buddy
  end tell
end run`;
  await run("osascript", ["-e", script, handle, text]);
}

/**
 * What an outbound message looks like with no rich surface to put it on.
 *
 * A card is a title, a body and its fields laid out as lines. Buttons are
 * listed rather than dropped: the owner cannot press one, but they can see
 * what was on offer and say it back, and a silent omission would make the
 * agent look like it had said less than it did.
 */
export function renderForText(msg: OutboundMessage): string {
  const parts: string[] = [];
  if (msg.text) parts.push(msg.text);
  const card = msg.card;
  if (card) {
    const block: string[] = [];
    if (card.title) block.push(card.title);
    if (card.body) block.push(card.body);
    for (const field of card.fields ?? []) {
      if (field.name.trim() && field.name !== "​") {
        block.push(`${field.name}: ${field.value}`);
      } else {
        block.push(field.value);
      }
    }
    if (card.url) block.push(card.url);
    if (card.footer) block.push(card.footer);
    if (block.length) parts.push(block.join("\n"));
  }
  if (msg.buttons?.length) {
    parts.push(
      `Reply with: ${msg.buttons.map((b) => `"${b.label}"`).join(", ")}`,
    );
  }
  return parts.join("\n\n").trim();
}

/** An owner's answer to an approval prompt, or nothing. */
export function parseDecision(
  text: string,
): { id: string; approved: boolean } | null {
  const match = /^\s*(approve|approved|yes|ok|deny|denied|no)\s*#?(\d+)\s*$/i.exec(
    text,
  );
  if (!match) return null;
  const verb = match[1]!.toLowerCase();
  return {
    id: match[2]!,
    approved: verb !== "deny" && verb !== "denied" && verb !== "no",
  };
}

export class IMessageAdapter implements ChannelAdapter {
  readonly name = "imessage";

  private readonly handle: string;
  private readonly dbPath: string;
  private readonly pollMs: number;
  private readonly sender: (handle: string, text: string) => Promise<void>;
  private readonly now: () => number;

  private reader: ThreadReader | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private watermark = 0;
  private messageHandler: MessageHandler | undefined;
  private approvalHandler: ApprovalHandler | undefined;
  private isAuthorized: SenderAuthorizer | undefined;
  /** Ids of prompts still awaiting an answer, so "approve 12" means something. */
  private readonly pending = new Set<string>();
  /**
   * What KOS has just said.
   *
   * A reply is sent into the same thread it is read from, so without this the
   * adapter reads its own words back as the owner's next message and answers
   * them, forever.
   */
  private readonly spoken: { text: string; at: number }[] = [];

  constructor(options: IMessageOptions) {
    this.handle = options.handle;
    this.dbPath = options.dbPath;
    this.pollMs = options.pollMs ?? 2000;
    this.sender = options.sender ?? sendViaMessages;
    this.now = options.now ?? Date.now;
  }

  async start(): Promise<void> {
    this.reader = new ThreadReader({
      handle: this.handle,
      path: this.dbPath,
    });
    // From here on, not from the beginning of the thread.
    this.watermark = this.reader.watermark();
    this.timer = setInterval(() => {
      void this.poll();
    }, this.pollMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.reader?.close();
    this.reader = undefined;
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  onApproval(handler: ApprovalHandler): void {
    this.approvalHandler = handler;
  }

  setAuthorizer(isAuthorized: SenderAuthorizer): void {
    this.isAuthorized = isAuthorized;
  }

  async send(_recipientId: string, msg: OutboundMessage): Promise<void> {
    const text = renderForText(msg);
    if (!text) return;
    this.remember(text);
    await this.sender(this.handle, text);
  }

  async requestApproval(
    _recipientId: string,
    req: ApprovalRequest,
  ): Promise<void> {
    this.pending.add(req.id);
    const lines = [req.text];
    if (req.reason) lines.push(req.reason);
    lines.push(`Reply "approve ${req.id}" or "deny ${req.id}".`);
    const text = lines.join("\n");
    this.remember(text);
    await this.sender(this.handle, text);
  }

  /** Read whatever is new, and turn it into a message or a decision. */
  async poll(): Promise<void> {
    if (!this.reader) return;
    let fresh: ThreadMessage[];
    try {
      fresh = this.reader.since(this.watermark);
    } catch {
      // A locked or rotated database is a reason to try again shortly, not to
      // bring the surface down.
      return;
    }
    for (const message of fresh) {
      this.watermark = Math.max(this.watermark, message.rowId);
      if (this.wasSpoken(message.text)) continue;
      await this.deliver(message);
    }
  }

  private async deliver(message: ThreadMessage): Promise<void> {
    if (this.isAuthorized && !this.isAuthorized(this.handle)) return;

    const decision = parseDecision(message.text);
    if (decision && this.pending.has(decision.id)) {
      this.pending.delete(decision.id);
      await this.approvalHandler?.({
        id: decision.id,
        approved: decision.approved,
        deciderId: this.handle,
      });
      return;
    }

    await this.messageHandler?.({
      channel: this.name,
      senderId: this.handle,
      text: message.text,
    });
  }

  /** Note something KOS said, and forget what is too old to still echo. */
  private remember(text: string): void {
    const at = this.now();
    this.spoken.push({ text, at });
    while (this.spoken.length && at - this.spoken[0]!.at > ECHO_WINDOW_MS) {
      this.spoken.shift();
    }
  }

  /**
   * Was this KOS's own message coming back?
   *
   * Consumed on the first match rather than merely tested, so that an owner
   * who genuinely types the same words later is heard.
   */
  private wasSpoken(text: string): boolean {
    const index = this.spoken.findIndex((s) => s.text === text);
    if (index === -1) return false;
    this.spoken.splice(index, 1);
    return true;
  }
}
