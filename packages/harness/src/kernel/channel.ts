import { ChannelRuntime } from "../channels/runtime.js";
import type { ChannelAdapter } from "../channels/types.js";
import type { UserMapping } from "../channels/identity.js";
import type { Kernel } from "./kernel.js";

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
    // So a prompt sent here is settled when the owner answers it in the
    // dashboard instead, rather than sitting there offering a choice that
    // has already been made.
    watchDecisions: (listener) =>
      kernel.approvals.onDecided((action) => {
        if (action.status === "approved" || action.status === "denied") {
          listener(String(action.id), action.status);
        }
      }),
    handleTurn: async (ctx) => {
      // The kernel owns conversation resolution and the /new, /chats, /switch
      // verbs, so every adapter behaves the same without implementing any of it.
      const res = await kernel.handleChannelTurn({
        text: ctx.text,
        userId: ctx.userId,
        channel: ctx.channel,
        ...(ctx.conversationKey ? { conversationKey: ctx.conversationKey } : {}),
        ...(ctx.attachments?.length ? { attachments: ctx.attachments } : {}),
      });
      return res.reply || "(no reply)";
    },
    /*
     * Only what the prompt itself does not already say.
     *
     * A surface takes a decision by settling its own prompt in place -- the
     * card becomes "Approved, running #96" and the buttons go. Sending
     * "Approved #96." afterwards restated that as a second message, so one
     * decision read as two.
     *
     * Two things still deserve their own message. A resumed turn's reply is
     * the answer the owner is waiting for, and it is not on the prompt. A
     * failure contradicts the prompt, which is left claiming the action is
     * running.
     */
    handleDecision: async (ctx) => {
      const id = Number(ctx.pendingId);
      let text: string | undefined;
      if (ctx.approved) {
        const res = await kernel.approve(id);
        if (res.reply) text = res.reply;
        else if (res.isError) text = `Approved #${id} failed: ${res.message}`;
        // A row that was already gone was never settled in place either, so
        // silence here would be a press that did nothing and said nothing.
        else if (!res.ok) text = res.message;
      } else {
        const res = await kernel.deny(id);
        text = res.reply ?? (res.ok ? undefined : res.message);
      }
      if (text) await adapter.send(options.ownerRecipientId, { text });
    },
  });
}
