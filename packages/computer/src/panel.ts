import type {
  ApprovalHandler,
  ApprovalOutcome,
  ApprovalRequest,
  ChannelAdapter,
  ChatEvent,
  InboundMessage,
  MessageHandler,
  OutboundMessage,
  TurnPresence,
  UserMapping,
} from "@kos/harness";

import type { DeviceHub } from "./hub.js";
import type { DeviceEvent, PanelMessage, PanelMethod } from "./protocol.js";

/**
 * The side panel of a paired Chrome, as a surface KOS talks on.
 *
 * The KOS extension opens a panel beside the owner's tabs with a chat in it.
 * Its words come over the Chrome's own line, as events, and run as turns of
 * the "chrome" surface, one stream like iMessage's, with /new and /switch.
 * What KOS has to say goes back as calls: the chat as it stands after each
 * turn (the transcript is the truth, so a turn taken on the dashboard shows
 * there too), the turn's steps while it runs, and an approval to decide in
 * place. Every Chrome paired with this KOS is the owner's, since only the
 * owner can make a pairing code, so each is a sender the owner speaks as.
 */

export interface PanelChat {
  id: string;
  title: string;
}

export interface PanelDeps {
  /** The chat the panel shows: the Chrome surface's current one, without making one. */
  current(): PanelChat | undefined;
  /** That chat as a reader sees it. */
  events(conversation: string): ChatEvent[];
}

/** The longest message the panel sends, and how much of the chat it is shown. */
const MAX_TEXT = 20_000;
const SHOWN = 200;
const MAX_ARGS = 600;

export class ChromePanel implements ChannelAdapter {
  readonly name = "chrome";
  private hub: DeviceHub | undefined;
  private unsubscribe: (() => void) | undefined;
  private messages: MessageHandler | undefined;
  private decisions: ApprovalHandler | undefined;
  /** The Chrome the owner last spoke from: the page chrome.page reads, the Chrome chrome.start works in. */
  private last: string | undefined;

  constructor(private readonly deps: PanelDeps) {}

  /** The hub while computer use is on; with none, the panel hears nothing and says nothing. */
  attach(hub: DeviceHub | undefined): void {
    this.unsubscribe?.();
    this.hub = hub;
    this.unsubscribe = hub?.onDeviceEvent((device, event) => this.heard(device, event));
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {
    this.attach(undefined);
  }

  onMessage(handler: MessageHandler): void {
    this.messages = handler;
  }

  onApproval(handler: ApprovalHandler): void {
    this.decisions = handler;
  }

  /** Who may speak here: any Chrome paired with this KOS, as the owner. */
  identity(ownerId: string): UserMapping {
    return { resolve: (channel, sender) => (channel === this.name && this.isChrome(sender) ? ownerId : null) };
  }

  /** The Chrome whose panel a chat is, when it is the panel's chat and the owner spoke there. */
  chromeOf(conversation: string): string | undefined {
    return this.last && this.isChrome(this.last) && conversation === this.deps.current()?.id ? this.last : undefined;
  }

  /** A decision's outcome, or a resumed turn's answer: every open panel is shown the chat with it. */
  async send(_recipient: string, msg: OutboundMessage): Promise<void> {
    await this.show(undefined, msg);
  }

  /** An approval the panel's chat asked for, to decide in the panel. Any other chat's is not the panel's to show. */
  async requestApproval(_recipient: string, req: ApprovalRequest): Promise<void> {
    if (!req.asker || req.asker.conversationId !== this.deps.current()?.id) return;
    const args = argsText(req.args);
    await this.everyChrome("chat.ask", {
      approval: { id: req.id, tool: req.tool ?? "", ...(args ? { args } : {}), ...(req.why ? { why: req.why } : {}), ...(req.reason ? { reason: req.reason } : {}) },
    });
  }

  async settleApproval(id: string, outcome: ApprovalOutcome): Promise<void> {
    await this.everyChrome("chat.settled", { approval: id, outcome });
  }

  async acknowledge(msg: InboundMessage): Promise<TurnPresence> {
    const chrome = msg.senderId;
    return {
      update: async (story) => void (await this.tell(chrome, "chat.status", { story })),
      complete: (reply) => this.show(chrome, reply),
      fail: async (message) => void (await this.tell(chrome, "chat.status", { story: null, error: message })),
    };
  }

  /** The chat changed somewhere else: a turn on the dashboard, one resumed after a decision. */
  refresh(): Promise<void> {
    return this.show(undefined);
  }

  /**
   * The chat as it stands, to one Chrome or every one that is on. What was
   * answered and is not in the chat's words (a command's answer, a blob's, a
   * turn waiting on the owner) goes with it as a notice.
   */
  private async show(chrome: string | undefined, said?: OutboundMessage): Promise<void> {
    const chat = this.deps.current();
    const messages = chat ? panelLines(this.deps.events(chat.id)) : [];
    const last = messages.at(-1);
    const text = said?.text?.trim();
    const notice = text && !(last?.role === "kos" && last.text === text) ? { text, ...(said?.from ? { from: said.from.name } : {}) } : undefined;
    const params = { conversation: chat?.id ?? null, title: chat?.title ?? "Chrome", messages, ...(notice ? { notice } : {}) };
    if (chrome) await this.tell(chrome, "chat.show", params);
    else await this.everyChrome("chat.show", params);
  }

  private heard(chrome: string, event: DeviceEvent): void {
    if (!event.name.startsWith("chat.") || !this.isChrome(chrome)) return;
    const data = event.data;
    switch (event.name) {
      case "chat.open":
        void this.show(chrome);
        return;
      case "chat.send": {
        const text = typeof data["text"] === "string" ? data["text"].trim().slice(0, MAX_TEXT) : "";
        if (!text) return;
        this.last = chrome;
        void this.messages?.({ channel: this.name, senderId: chrome, text });
        return;
      }
      case "chat.decide":
        if (typeof data["approval"] === "string" && typeof data["approved"] === "boolean") {
          void this.decisions?.({ id: data["approval"], approved: data["approved"], deciderId: chrome });
        }
        return;
      default:
        return;
    }
  }

  private isChrome(id: string): boolean {
    return this.hub?.list().some((d) => d.id === id && d.kind === "browser") ?? false;
  }

  /** Said to a Chrome, which shows it if its panel is open; one that is off is not told. */
  private async tell(chrome: string, method: PanelMethod, params: Record<string, unknown>): Promise<boolean> {
    if (!this.hub) return false;
    try {
      await this.hub.request(chrome, method, params);
      return true;
    } catch {
      return false;
    }
  }

  private async everyChrome(method: PanelMethod, params: Record<string, unknown>): Promise<void> {
    const on = this.hub?.list().filter((d) => d.kind === "browser" && d.online) ?? [];
    await Promise.all(on.map((d) => this.tell(d.id, method, params)));
  }
}

/**
 * A chat as the panel draws it: the words each way, the notes between them,
 * and each run of tool calls folded into the steps a turn took. The model's
 * reasoning stays out; the panel is a conversation, not a log.
 */
export function panelLines(events: ChatEvent[], max = SHOWN): PanelMessage[] {
  const out: PanelMessage[] = [];
  for (const event of events) {
    switch (event.kind) {
      case "message": {
        if (event.role === "system") {
          out.push({ role: "note", text: event.text });
          break;
        }
        if (event.role === "kos") {
          if (event.text) out.push({ role: "kos", text: event.text });
          break;
        }
        const files = event.attachments?.map((a) => a.name) ?? [];
        if (event.text || files.length) out.push({ role: "you", text: event.text, ...(files.length ? { files } : {}) });
        break;
      }
      case "tool": {
        const step = { summary: event.summary, ...(event.isError ? { failed: true as const } : {}) };
        const last = out.at(-1);
        if (last?.role === "steps") last.steps.push(step);
        else out.push({ role: "steps", steps: [step] });
        break;
      }
      case "divider":
        out.push({ role: "note", text: event.text });
        break;
      default:
        break;
    }
  }
  return out.slice(-max);
}

function argsText(args: ApprovalRequest["args"]): string {
  if (args === undefined) return "";
  const text = typeof args === "string" ? args : JSON.stringify(args);
  return text.length > MAX_ARGS ? `${text.slice(0, MAX_ARGS)}…` : text;
}
