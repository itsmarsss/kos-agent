import { agentConversationId } from "../agents/roles.js";
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
    ownerRecipientId: options.ownerRecipientId,
    ...(options.identity ? { identity: options.identity } : {}),
    // So a prompt sent here is settled when the owner answers it in the
    // dashboard instead, rather than sitting there offering a choice that
    // has already been made.
    watchDecisions: (listener) =>
      kernel.approvals.onDecided((action) => {
        if (action.status !== "pending") listener(String(action.id), action.status);
      }),
    // The turn's own conversation is known before it runs, so its progress
    // can be told on the surface as it happens. A message addressed to an
    // agent runs in the agent's thread, so that is the one to watch.
    watchTurn: (ctx, listener) => {
      const addressed = ctx.text ? kernel.addressedAgent(ctx.text) : undefined;
      // A bound channel's turn runs in the conversation it is bound to.
      const id = addressed ? agentConversationId(addressed.name) : (ctx.conversationId ?? kernel.conversationFor(ctx.channel, ctx.userId, ctx.conversationKey).id);
      return kernel.progress.subscribe((event) => {
        if (event.conversationId === id) listener(event);
      });
    },
    handleTurn: async (ctx) => {
      // The kernel owns conversation resolution and the /new, /chats, /switch
      // verbs, so every adapter behaves the same without implementing any of it.
      const res = await kernel.handleChannelTurn({
        text: ctx.text,
        userId: ctx.userId,
        channel: ctx.channel,
        ...(ctx.conversationKey ? { conversationKey: ctx.conversationKey } : {}),
        ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
        ...(ctx.newIn ? { newIn: ctx.newIn } : {}),
        ...(ctx.attachments?.length ? { attachments: ctx.attachments } : {}),
        ...(ctx.guest ? { guest: ctx.guest } : {}),
      });
      // The owner asked from this surface and the answer lands on it, so
      // the thread is read as far as they are concerned.
      kernel.conversations.markRead(res.conversationId);
      // A blob's answer carries its name, for the surface to show as a tag.
      // A turn waiting on an approval says so, so the surface keeps telling
      // its story until the rest of it has run.
      const waiting = res.suspended ? { suspended: true as const } : {};
      if (res.from && res.reply) return { text: res.reply, from: res.from, ...waiting };
      return res.suspended ? { text: res.reply || "(no reply)", ...waiting } : res.reply || "(no reply)";
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
        const res = await kernel.approve(id, undefined, { remember: ctx.remember === true });
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
