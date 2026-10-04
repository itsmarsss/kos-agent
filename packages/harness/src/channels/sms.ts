import { createHmac } from "node:crypto";

import { parseDecision, renderForText } from "./imessage.js";
import type {
  ApprovalHandler,
  ApprovalRequest,
  ChannelAdapter,
  MessageHandler,
  OutboundMessage,
  SenderAuthorizer,
} from "./types.js";

/**
 * SMS, through a Twilio number, as one thread the owner talks to KOS in.
 *
 * The spec's target channel. Like iMessage it is text and nothing else, so
 * the same rendering down applies: a card becomes lines, an approval
 * becomes a sentence with the words that answer it. Unlike iMessage, which
 * is read from a database on this machine, SMS arrives as a webhook from
 * Twilio, so the host has to be reachable from the internet (a tunnel or a
 * forwarded port) and every inbound request is checked against Twilio's
 * signature before a word of it is read.
 *
 * One number, the owner's. A text from anyone else is dropped and logged,
 * never answered: answering would tell a stranger there is something here.
 */

export interface SmsOptions {
  accountSid: string;
  authToken: string;
  /** The Twilio number KOS sends from. */
  from: string;
  /** The owner's number, the only one read or written. */
  owner: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Where Twilio was told to post, when a proxy hides it from the request. */
  publicUrl?: string;
  report?: (message: string) => void;
}

/** One SMS segment is 160 characters; Twilio concatenates up to 1600. */
export const SMS_CHUNK = 1500;

export function chunkSms(text: string, max = SMS_CHUNK): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const cut = rest.lastIndexOf("\n", max);
    const at = cut > max / 2 ? cut : max;
    out.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n/, "");
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Twilio's request signature: HMAC-SHA1 over the URL it posted to with the
 * form's parameters appended, sorted by name, each as name then value, and
 * the digest base64. The owner's auth token is the key.
 */
export function twilioSignature(url: string, params: Record<string, string>, authToken: string): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return createHmac("sha1", authToken).update(data).digest("base64");
}

export function verifyTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string | undefined,
  authToken: string,
): boolean {
  if (!signature) return false;
  const expected = twilioSignature(url, params, authToken);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

export class SmsAdapter implements ChannelAdapter {
  readonly name = "sms";
  private messageHandler?: MessageHandler;
  private approvalHandler?: ApprovalHandler;
  private isAuthorized?: SenderAuthorizer;
  private readonly pending = new Set<string>();
  private readonly doFetch: typeof fetch;
  private readonly report: (message: string) => void;

  constructor(private readonly options: SmsOptions) {
    this.doFetch = options.fetch ?? fetch;
    this.report = options.report ?? (() => undefined);
  }

  async start(): Promise<void> {
    // Nothing to open: messages arrive through the host's webhook route.
  }

  async stop(): Promise<void> {}

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
    for (const part of chunkSms(text)) await this.deliver(part);
  }

  async requestApproval(_recipientId: string, req: ApprovalRequest): Promise<void> {
    this.pending.add(req.id);
    const lines = [req.text];
    if (req.reason) lines.push(req.reason);
    lines.push(`Reply "approve ${req.id}", "always ${req.id}" to stop asking for this, or "deny ${req.id}".`);
    for (const part of chunkSms(lines.join("\n"))) await this.deliver(part);
  }

  /**
   * An inbound webhook, already verified by the host. Twilio's form: From,
   * To, Body, and more that is not read.
   */
  async receive(params: Record<string, string>): Promise<void> {
    const from = (params["From"] ?? "").trim();
    const text = (params["Body"] ?? "").trim();
    if (from !== this.options.owner) {
      this.report(`sms: dropped a text from ${from.replace(/\d(?=\d{2})/g, "•")}`);
      return;
    }
    if (this.isAuthorized && !this.isAuthorized(from)) return;
    if (!text) return;
    const decision = parseDecision(text);
    if (decision && this.pending.has(decision.id)) {
      this.pending.delete(decision.id);
      await this.approvalHandler?.({
        id: decision.id,
        approved: decision.approved,
        deciderId: from,
        ...(decision.remember ? { remember: true } : {}),
      });
      return;
    }
    await this.messageHandler?.({ channel: this.name, senderId: from, text });
  }

  private async deliver(body: string): Promise<void> {
    const { accountSid, authToken, from, owner } = this.options;
    const res = await this.doFetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ From: from, To: owner, Body: body }).toString(),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`twilio: ${res.status} ${detail.slice(0, 200)}`);
    }
  }
}
