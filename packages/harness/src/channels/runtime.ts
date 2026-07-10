import { runAgent, type Inference } from "../agent/loop.js";
import type { ToolRegistry } from "../agent/registry.js";
import { SingleOwnerMapping, type UserMapping } from "./identity.js";
import type { ChannelAdapter, InboundMessage, TurnPresence } from "./types.js";

export interface TurnContext {
  userId: string;
  channel: string;
  senderId: string;
  text: string;
}

/** Handles one user turn and returns the reply text. */
export type TurnHandler = (ctx: TurnContext) => Promise<string>;

export interface ChannelRuntimeOptions {
  adapter: ChannelAdapter;
  handleTurn: TurnHandler;
  identity?: UserMapping;
  /** Reply sent when a turn throws, instead of leaking the error to the user. */
  errorReply?: string;
}

/**
 * Binds a channel adapter to a turn handler: inbound message -> resolve user ->
 * run the turn -> send (or complete presence). Channel-agnostic.
 */
export class ChannelRuntime {
  private readonly adapter: ChannelAdapter;
  private readonly handleTurn: TurnHandler;
  private readonly identity: UserMapping;
  private readonly errorReply: string;

  constructor(options: ChannelRuntimeOptions) {
    this.adapter = options.adapter;
    this.handleTurn = options.handleTurn;
    this.identity = options.identity ?? new SingleOwnerMapping();
    this.errorReply =
      options.errorReply ?? "Something went wrong handling that.";
  }

  async start(): Promise<void> {
    this.adapter.onMessage((msg) => this.dispatch(msg));
    await this.adapter.start();
  }

  async stop(): Promise<void> {
    await this.adapter.stop();
  }

  private async dispatch(msg: InboundMessage): Promise<void> {
    const userId = this.identity.resolve(msg.channel, msg.senderId);
    let presence: TurnPresence | undefined;
    try {
      presence = await this.adapter.acknowledge?.(msg);
    } catch {
      presence = undefined;
    }

    try {
      const reply = await this.handleTurn({
        userId,
        channel: msg.channel,
        senderId: msg.senderId,
        text: msg.text,
      });
      if (presence) {
        await presence.complete(reply || "(no reply)");
      } else {
        await this.adapter.send(msg.senderId, { text: reply || "(no reply)" });
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
