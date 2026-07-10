import { ChannelRuntime } from "../channels/runtime.js";
import type { ChannelAdapter } from "../channels/types.js";
import type { UserMapping } from "../channels/identity.js";
import type { Kernel } from "./kernel.js";
import { primarySessionId } from "./session.js";

export interface ConnectChannelOptions {
  /** Channel-native id of the owner, for outbound notify + approval prompts. */
  ownerRecipientId: string;
  identity?: UserMapping;
}

/**
 * Bridge a channel adapter to the kernel: inbound messages run the guarded
 * agent loop and the reply is sent back; approve/deny decisions (Discord
 * buttons) resolve the matching pending action and the outcome is sent to the
 * owner. Works with any ChannelAdapter (Discord, in-memory, future SMS).
 *
 * Note: the kernel's onApprovalRequested (set at boot) should call
 * adapter.requestApproval so risky actions surface as a prompt; this function
 * wires the return path.
 */
export function connectChannel(
  adapter: ChannelAdapter,
  kernel: Kernel,
  options: ConnectChannelOptions,
): ChannelRuntime {
  const runtime = new ChannelRuntime({
    adapter,
    ...(options.identity ? { identity: options.identity } : {}),
    handleTurn: async (ctx) => {
      const res = await kernel.handleMessage(ctx.text, {
        userId: ctx.userId,
        // Same primary session as the CLI so Discord and kos share history.
        sessionId: primarySessionId(ctx.userId),
      });
      return res.reply || "(no reply)";
    },
  });

  adapter.onApproval(async (decision) => {
    const id = Number(decision.id);
    const result = decision.approved
      ? (await kernel.approve(id)).message
      : kernel.deny(id).message;
    await adapter.send(options.ownerRecipientId, { text: result });
  });

  return runtime;
}
