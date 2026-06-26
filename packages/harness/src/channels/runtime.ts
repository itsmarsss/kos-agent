import { runAgent, type Inference } from "../agent/loop.js";
import type { ToolRegistry } from "../agent/registry.js";
import { SingleOwnerMapping, type UserMapping } from "./identity.js";
import type { ChannelAdapter, InboundMessage } from "./types.js";

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
 * run the turn -> send the reply. Channel-agnostic, so any adapter (memory,
 * Discord, SMS) drives the same agent path.
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
    let reply: string;
    try {
      reply = await this.handleTurn({
        userId,
        channel: msg.channel,
        senderId: msg.senderId,
        text: msg.text,
      });
    } catch {
      reply = this.errorReply;
    }
    await this.adapter.send(msg.senderId, { text: reply });
  }
}

export interface AgentTurnOptions {
  system?: string;
  maxIterations?: number;
}

/**
 * Build a TurnHandler that runs the agent loop for each message and returns the
 * agent's final text. Turns are currently stateless (one message in, one reply
 * out); cross-turn context comes with the memory and context-policy steps.
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
