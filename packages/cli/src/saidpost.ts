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
  /** The words came in the owner's DM. */
  dm?: boolean;
  /** A scheduled run where something failed. */
  failed?: boolean;
}

/** A scheduled job, as much of it as where its runs speak depends on. */
export interface JobFacts {
  id: number;
  name: string;
  type: "actions" | "self_prompt";
  projectSlug: string | null;
}

/** KOS's own upkeep (kos.backup, kos.memory, kos.dream, kos.observe, kos.improve): it speaks only when something needs the owner. */
export function isUpkeep(job: Pick<JobFacts, "name">): boolean {
  return job.name.startsWith("kos.");
}

/**
 * Whether what a job sends to its place pings the owner. A fixed-actions
 * job's message is a reminder in the owner's own words, set for the time
 * they wanted to hear it, so it @mentions them; a prompted run decides
 * what is worth saying and posts without a ping, as any message in a
 * thread does. KOS's upkeep pings nobody.
 */
export function pingsOwner(job: Pick<JobFacts, "name" | "type">): boolean {
  return job.type === "actions" && !isUpkeep(job);
}

/** What finding a conversation's place on the server needs. */
export interface PlaceDeps {
  /** Where a conversation shows on the server: its channel or thread, or nothing. */
  targetFor(conversationId: string): string | undefined;
  /** The channel key its thread is made under (a project's, or KOS's own at the root), or nothing. */
  homeOf(conversationId: string): string | undefined;
  /** What a new thread for it is called. */
  titleOf(conversationId: string): string;
  ensureThread(channelKey: string, conversationId: string, title: string): Promise<string | undefined>;
  bindThread(threadId: string, conversationId: string): void;
  /** Make the owner a member of a thread, so what lands there notifies them as a DM would; nothing for a channel. Never throws. */
  joinOwner(placeId: string): Promise<void>;
  /** Let go of a channel or thread Discord says is gone, and whatever was bound to it. */
  forgetPlace(placeId: string): void;
  postIn(target: string, msg: OutboundMessage): Promise<void>;
  /** Whether Discord is reachable now. */
  connected(): boolean;
  /** A post kept in the send queue with a way to find its place, found once Discord is back. */
  postWhenFound(find: () => Promise<string | undefined>, msg: OutboundMessage): Promise<void>;
}

/** Discord's answer for a channel or thread that no longer exists. */
function goneFromDiscord(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 10003;
}

/**
 * A scheduled run's message posted in its place. A place Discord says is
 * gone (a thread deleted under it) is let go and a new one found once;
 * false when there is no place, or none that takes the post.
 */
export async function postInPlace(conversationId: string, msg: OutboundMessage, deps: PlaceDeps): Promise<boolean> {
  // With Discord down a thread cannot be made, and its home channel's top
  // is not its place: the post waits in the send queue, and the thread is
  // made when Discord is back. A place already there is queued by the post.
  if (!deps.connected() && !deps.targetFor(conversationId) && deps.homeOf(conversationId)) {
    await deps.postWhenFound(() => placeOf(conversationId, deps), msg);
    return true;
  }
  for (let tries = 0; tries < 2; tries++) {
    const where = await placeOf(conversationId, deps).catch(() => undefined);
    if (!where) return false;
    try {
      await deps.postIn(where, msg);
      return true;
    } catch (err) {
      if (!goneFromDiscord(err)) throw err;
      deps.forgetPlace(where);
    }
  }
  return false;
}

/**
 * Where a scheduled run speaks on the server: its own channel or thread,
 * the thread made now under its home when it has none yet, or its home's
 * channel when no thread can be made. Nothing when it has no place there.
 * Only a run's place (a job's, a blob's, KOS upkeep's) is found here, and
 * the owner is made a member of the thread it finds, so a post there
 * reaches them as the DM did; a mirrored chat's thread is not joined.
 */
export async function placeOf(conversationId: string, deps: PlaceDeps): Promise<string | undefined> {
  const where = await findPlace(conversationId, deps);
  if (where) await deps.joinOwner(where);
  return where;
}

async function findPlace(conversationId: string, deps: PlaceDeps): Promise<string | undefined> {
  const bound = deps.targetFor(conversationId);
  if (bound) return bound;
  const home = deps.homeOf(conversationId);
  if (!home) return undefined;
  const made = await deps.ensureThread(home, conversationId, deps.titleOf(conversationId)).catch(() => undefined);
  if (made) {
    deps.bindThread(made, conversationId);
    return made;
  }
  return deps.targetFor(home);
}

export interface SaidDeps extends PlaceDeps {
  /** The scheduled job a conversation is the thread of, when it is one. */
  jobOf(conversationId: string): JobFacts | undefined;
  /** Whether a scheduled run here already said its piece in its place this turn; asking clears it. */
  spokeInPlace(conversationId: string): boolean;
  senderFor(conversationId: string): Sender | undefined;
  speakerFor(from: MessageFrom): Sender;
  ownerSender(): Promise<Sender | undefined>;
  filesFor(files: { name: string; path: string }[]): NonNullable<OutboundMessage["files"]>;
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
  // A run whose message already landed in its place has said its piece;
  // its closing words ("Digest sent") would only repeat it. A failure after
  // it is news all the same.
  const spoke = deps.spokeInPlace(said.conversationId) && said.origin === "system" && !said.failed;
  // A scheduled run shows in the job's own thread, under the job's name: a
  // project's job under the project's channel, one at the root under KOS's
  // own. A daily post is what a schedule is for. Only a run the harness
  // started gets the run format; anything the owner says in a job's thread
  // is a conversation, told below. KOS's upkeep keeps its runs to itself.
  const job = deps.jobOf(said.conversationId);
  if (job && said.origin === "system") {
    if (spoke || isUpkeep(job) || !said.reply.trim()) return;
    // With a Run now button, the same path the dashboard's Run now takes.
    await postInPlace(said.conversationId, { text: `-# ${job.name}\n${said.reply}`, buttons: [{ label: "Run now", cron: job.id }] }, deps);
    return;
  }
  if (spoke) return;
  const target = deps.targetFor(said.conversationId);
  const from = deps.senderFor(said.conversationId);
  // A resumed turn asked in the DM is answered in the DM, where it was
  // asked, even when its chat also has a thread; one with no channel or
  // thread has nowhere else to go.
  if (said.channel === "discord" && said.resumed && (said.dm || !target)) {
    if (said.reply.trim()) await deps.sendOwner({ text: said.reply, ...(from ? { from } : {}) });
    return;
  }
  if (!target) return;
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
