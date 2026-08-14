import { ChannelRuntime } from "../channels/runtime.js";
import type { ChannelAdapter } from "../channels/types.js";
import type { UserMapping } from "../channels/identity.js";
import type { Kernel } from "./kernel.js";
import { primarySessionId } from "./session.js";

export interface ConnectChannelOptions {
  /** Channel-native id of the owner, for outbound notify + approval prompts. */
  ownerRecipientId: string;
  /**
   * Sender -> KOS user, and the inbound authorization gate. Required for any
   * public surface; omitting it trusts every sender (in-process adapters only).
   */
  identity?: UserMapping;
}

/**
 * Bridge a channel adapter to the kernel: inbound messages run the guarded
 * agent loop and the reply is sent back; approve/deny decisions (Discord
 * buttons) resolve the matching pending action and the outcome is sent to the
 * owner. Works with any ChannelAdapter (Discord, in-memory, future SMS).
 *
 * Both paths go through ChannelRuntime, so the identity mapping decides who may
 * run a turn and who may resolve a pending risky action.
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
  return new ChannelRuntime({
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
    handleDecision: async (ctx) => {
      const id = Number(ctx.pendingId);
      // approve/deny execute + resume the agent; send one user-facing reply.
      if (ctx.approved) {
        const res = await kernel.approve(id);
        const text =
          res.reply ??
          (res.isError
            ? `Approved #${id} failed: ${res.message}`
            : `Approved #${id}.`);
        await adapter.send(options.ownerRecipientId, { text });
      } else {
        const res = await kernel.deny(id);
        await adapter.send(options.ownerRecipientId, {
          text: res.reply ?? res.message,
        });
      }
    },
  });
}
