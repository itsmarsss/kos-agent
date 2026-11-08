import type { MessageFrom, OutboundMessage, Sender } from "@kos/harness";

/** A turn's exchange as the bus tells it, for the turns the thread mirror was not narrating. */
export interface Said {
  conversationId: string;
  text: string;
  reply: string;
  origin: "owner" | "system";
  channel: string | null;
  files: { name: string; path: string }[];
  resumed?: boolean;
  from?: MessageFrom;
}

export interface SaidDeps {
  /** Where a conversation shows on the server: its channel or thread, or nothing. */
  targetFor(conversationId: string): string | undefined;
  /** The scheduled job a conversation is the thread of, when it is one. */
  jobOf(conversationId: string): { id: number; name: string; projectSlug: string | null } | undefined;
  ensureThread(channelKey: string, conversationId: string, title: string): Promise<string | undefined>;
  bindThread(threadId: string, conversationId: string): void;
  senderFor(conversationId: string): Sender | undefined;
  speakerFor(from: MessageFrom): Sender;
  ownerSender(): Promise<Sender | undefined>;
  filesFor(files: { name: string; path: string }[]): NonNullable<OutboundMessage["files"]>;
  postIn(target: string, msg: OutboundMessage): Promise<void>;
  /** The owner's DM. */
  sendOwner(msg: OutboundMessage): Promise<void>;
}

/**
 * A turn's exchange shown on Discord, for a turn the thread mirror was not
 * narrating: a scheduled run's result, a resumed Discord turn's answer, a
 * dashboard turn in a chat with a channel or thread.
 */
export async function postSaid(said: Said, deps: SaidDeps): Promise<void> {
  // A turn from Discord is answered by the presence that took it; one
  // that waited on an approval was answered "waiting on you" there, and
  // the answer after the decision has only this way back.
  if (said.channel === "discord" && !said.resumed) return;
  // A scheduled run of a project's job shows in the job's own thread, under
  // the job's name: a daily post is what a schedule is for. Only a run the
  // harness started gets the run format; anything the owner says in a job's
  // thread is a conversation, told below.
  const job = deps.jobOf(said.conversationId);
  if (job && said.origin === "system") {
    let where = deps.targetFor(said.conversationId);
    if (!where && job.projectSlug) {
      where = await deps.ensureThread(`project:${job.projectSlug}`, said.conversationId, job.name).catch(() => undefined);
      if (where) deps.bindThread(where, said.conversationId);
    }
    where ??= job.projectSlug ? deps.targetFor(`project:${job.projectSlug}`) : undefined;
    // With a Run now button, the same path the dashboard's Run now takes.
    if (where && said.reply.trim()) await deps.postIn(where, { text: `-# ${job.name}\n${said.reply}`, buttons: [{ label: "Run now", cron: job.id }] });
    return;
  }
  const target = deps.targetFor(said.conversationId);
  const from = deps.senderFor(said.conversationId);
  if (!target) {
    // A resumed turn asked in the DM has no channel or thread: its answer goes back to the DM.
    if (said.channel === "discord" && said.resumed && said.reply.trim()) await deps.sendOwner({ text: said.reply, ...(from ? { from } : {}) });
    return;
  }
  if (said.origin === "owner" && said.text.trim() && said.channel !== "discord") {
    // The files that came with the words go too; one that is gone is simply not shown.
    const files = deps.filesFor(said.files);
    const attached = files.length ? { files } : {};
    if (said.from) {
      // Passed on by a chat or a schedule: under that sender's name and
      // face; the line says only that it was passed on.
      await deps.postIn(target, { text: `${said.text.trim()}\n-# passed on`, from: deps.speakerFor(said.from), silent: true, ...attached });
    } else {
      // As the owner, under their own name and picture; quoted by the bot
      // only when the owner cannot be looked up.
      const owner = await deps.ownerSender();
      const text = owner ? said.text.trim() : `${said.text.trim().split("\n").map((l) => `> ${l}`).join("\n")}\n-# you, on the dashboard`;
      await deps.postIn(target, { text, ...(owner ? { from: owner } : {}), silent: true, ...attached });
    }
  }
  if (said.reply.trim()) await deps.postIn(target, { text: said.reply, ...(from ? { from } : {}) });
}
