import { spawn } from "node:child_process";
import type { Server } from "node:http";
import { connect } from "node:net";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AllowlistMapping,
  ChannelRuntime,
  type ChannelAdapter,
  DiscordAdapter,
  type KeptPrompts,
  type PromptRef,
  type RoomCursors,
  type KeptStories,
  IMessageAdapter,
  describeStartFailure,
  SmsAdapter,
  verifyTwilioSignature,
  Kernel,
  activeOwnChat,
  approvalExpiry,
  connectChannel,
  MODEL_SETTINGS_KEY,
  conversationEvents,
  conversationKind,
  mentionsOf,
  withFrames,
  parseModelSettings,
  createDashboardServer,
  createDashboardSocket,
  handleApiRequest,
  createPressHandler,
  primarySessionId,
  surfaceSessionId,
  startSiteServer,
  SurfaceDownError,
  type ApprovalRequest,
  type DashboardServerOptions,
  type NotifyPayload,
  type NotifySent,
  type OutboundMessage,
  type PendingAction,
} from "@kos/harness";
import { createComputerUse, type Glance, type PanelArtifact, type PanelArtifacts, type PanelDeps, type PanelPlaceOf } from "@kos/computer";

/** The surfaces a device panel is: a Chrome's side panel, a Mac's window, a phone's chat. */
type PanelSurface = "chrome" | "mac" | "phone";

import { deviceUpdates } from "./deviceupdates.js";
import { envFilePath } from "./env.js";
import { ThreadMirror } from "./threadmirror.js";
import { pingsOwner, postInPlace, postSaid, type JobFacts, type PlaceDeps, type SaidDeps } from "./saidpost.js";
import { claimHandle, type HandleClaim } from "./imessagelock.js";
import { clearDaemonState, writeDaemonState } from "./state.js";

export interface HostOptions {
  rootDir: string;
  allowedHosts: string[] | (() => string[]);
  host: string;
  port: number;
  token?: string;
  /** Secret for `POST /api/hooks/<job>`; hooks are off without one. */
  hookSecret?: string;
  /** Start Discord when token+owner are present (default true). */
  discord?: boolean;
  /** Require Discord credentials or fail. */
  requireDiscord?: boolean;
  /**
   * Port for serving what the agent built. A different port from the dashboard
   * on purpose: a site is agent-written markup, and sharing the dashboard's
   * origin would let it drive the dashboard's API. Default is the dashboard
   * port plus one; 0 turns site serving off.
   */
  sitesPort?: number;
}

/** The port phones on the Wi-Fi reach KOS on: KOS_DEVICE_LAN_PORT, else the dashboard's plus two. */
function lanPort(dashboard: number): number {
  const set = Number(process.env.KOS_DEVICE_LAN_PORT ?? "");
  return Number.isInteger(set) && set > 0 && set < 65_536 ? set : dashboard + 2;
}

function defaultUiDist(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolve(here, "../../ui/dist");
  return existsSync(join(candidate, "index.html")) ? candidate : undefined;
}

function discordCreds(): { token: string; ownerId: string; guildId?: string } | null {
  const token =
    process.env.KOS_SECRET_DISCORD ??
    process.env.DISCORD_TOKEN ??
    process.env.DISCORD_BOT_TOKEN;
  const ownerId =
    process.env.KOS_OWNER_DISCORD ?? process.env.DISCORD_OWNER_ID;
  if (!token || !ownerId) return null;
  // A server of the owner's KOS lives in, with a channel per project and
  // per blob. Without it, KOS is a DM.
  const guildId = process.env.KOS_DISCORD_GUILD?.trim();
  return { token, ownerId, ...(guildId ? { guildId } : {}) };
}

/**
 * The one iMessage conversation KOS may read, and where Messages keeps them.
 *
 * The handle is configuration and never a literal: it is the owner's own
 * phone number or Apple ID, and this repository is public. Absent it, the
 * surface stays off rather than guessing at a thread.
 */
/**
 * SMS through Twilio, when the owner set it up. Four values, none of them
 * in code: the account, its auth token (a secret), the number KOS sends
 * from, and the owner's own number.
 */
function smsConfig(): { accountSid: string; authToken: string; from: string; owner: string; publicUrl?: string } | null {
  const accountSid = process.env.KOS_TWILIO_SID?.trim();
  const authToken = (process.env.KOS_SECRET_TWILIO ?? process.env.TWILIO_AUTH_TOKEN)?.trim();
  const from = process.env.KOS_TWILIO_FROM?.trim();
  const owner = process.env.KOS_OWNER_SMS?.trim();
  if (!accountSid || !authToken || !from || !owner) return null;
  const publicUrl = process.env.KOS_PUBLIC_URL?.trim();
  return { accountSid, authToken, from, owner, ...(publicUrl ? { publicUrl } : {}) };
}

function imessageConfig(): { handle: string; dbPath: string } | null {
  const handle = process.env.KOS_OWNER_IMESSAGE?.trim();
  if (!handle) return null;
  const dbPath =
    process.env.KOS_IMESSAGE_DB?.trim() ||
    join(homedir(), "Library", "Messages", "chat.db");
  return { handle, dbPath };
}

/**
 * Multi-modal host: one Kernel, cron, local API/UI, optional Discord.
 * This is what `kos start` runs. CLI clients attach over the API.
 */
/**
 * An error nobody caught is logged, and the host goes on.
 *
 * The default is to exit, which is right for a script and wrong for a
 * daemon that is the owner's only agent: the previous host died at 9am
 * from a timed-out socket inside a library, and nothing noticed until
 * the afternoon. Everything that matters is either answered on its own
 * promise chain or restarted by the kernel; a stray throw has nowhere
 * useful to go but the log.
 */
function keepRunning(): void {
  const describe = (err: unknown): string =>
    err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.on("uncaughtException", (err) => {
    console.error(`uncaught exception, still running: ${describe(err)}`);
  });
  process.on("unhandledRejection", (reason) => {
    console.error(`unhandled rejection, still running: ${describe(reason)}`);
  });
}

/**
 * The surface a message goes out on, when it is wired and up. A surface
 * named that is not wired here is an error; one wired but down (Discord
 * logging in, or dropped by its gateway) is the surface-down path, which
 * leaves a message for the owner on the dashboard instead.
 */
export function surfaceUp(surfaces: Map<string, () => ChannelAdapter | undefined>, surface: string, named: boolean): ChannelAdapter {
  const up = (name: string): ChannelAdapter | undefined => {
    const wired = surfaces.get(name)?.();
    return wired && wired.connected?.() !== false ? wired : undefined;
  };
  const connected = [...surfaces.keys()].filter((name) => up(name));
  if (named && !surfaces.has(surface)) throw new Error(`no ${surface} surface here. Connected: ${connected.join(", ") || "none"}.`);
  const send = up(surface);
  if (!send) throw new SurfaceDownError(surface, connected);
  return send;
}

/** The dashboard as Discord links to it: KOS_PUBLIC_URL when set, this host otherwise. */
export function dashboardUrlFor(host: string, port: number): string {
  return process.env.KOS_PUBLIC_URL?.trim() || `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`;
}

/** What saying a scheduled run's message in its place needs. */
export interface PlaceNotifierDeps extends PlaceDeps {
  /** The owner's id on the server, for a ping. */
  ownerId: string;
  /** The scheduled job a message is from, when it is one. */
  jobOf(payload: NotifyPayload): JobFacts | undefined;
  /** Whether the owner alone reads a conversation's place: a channel open to guests is no place for what was meant for the owner. */
  ownerOnly(conversationId: string): boolean;
  /** The owner's DM, for a post in a thread they could not be made a member of. */
  sendOwner(msg: OutboundMessage): Promise<void>;
}

/** What became of a run's message that asked for its place: said there, or left to the owner's DM, and why. */
export type PlaceSaid = { sent: NotifySent } | { dm: string };

/**
 * A scheduled run's unaddressed message, said in its own place on the
 * server (the job's thread, the blob's channel) rather than the owner's DM.
 * It remembers which runs said their piece there, so the run's closing
 * words do not repeat it.
 */
export class PlaceNotifier {
  /** Conversations whose scheduled run has said its piece this turn: in its place, or in the DM when guests read its place. */
  private readonly said = new Set<string>();

  constructor(private readonly deps: PlaceNotifierDeps) {}

  /** A new turn has said nothing in its place yet. */
  turnStarted(conversationId: string): void {
    this.said.delete(conversationId);
  }

  /** Whether a scheduled run here already said its piece this turn; asking clears it. */
  saidItsPiece(conversationId: string): boolean {
    return this.said.delete(conversationId);
  }

  /**
   * Said in the message's place, when it asks for one and has one the
   * owner alone reads and that takes the post. One that asks for a place
   * and is not said there is left to the owner's DM, with why; one that
   * asks for none is nothing here.
   */
  async say(payload: NotifyPayload, msg: OutboundMessage): Promise<PlaceSaid | undefined> {
    if (!payload.place || payload.target.kind !== "owner" || payload.target.surface) return undefined;
    // A place guests read is not the run's: the DM carries it, and the
    // run's closing words would only be a second DM for the same turn.
    if (!this.deps.ownerOnly(payload.place)) {
      this.said.add(payload.place);
      return { dm: "guests can read this run's place on Discord, so it was not posted there" };
    }
    const job = this.deps.jobOf(payload);
    // A fixed reminder, and news the owner must not miss (a job failing), ping them.
    const ping = payload.ping || (job && pingsOwner(job)) ? `<@${this.deps.ownerId}> ` : "";
    // A thread the owner could not join would not notify them: the DM carries it as well.
    let alsoDmed: boolean | undefined;
    const alsoDm = async (): Promise<void> => {
      alsoDmed = await this.deps.sendOwner(msg).then(
        () => true,
        (err: unknown) => {
          console.warn(`[discord] a run's message was not also sent to the owner's DM: ${err instanceof Error ? err.message : String(err)}`);
          return false;
        },
      );
    };
    const placed = await postInPlace(payload.place, { ...msg, text: `${ping}${msg.text}` }, this.deps, alsoDm);
    if (!placed) return { dm: "this run has no place on Discord that took the post" };
    this.said.add(payload.place);
    const pinging = ping ? ", pinging them" : "";
    if (placed === "held") {
      return { sent: { delivered: `Not posted yet: Discord is unreachable, so it is kept to post in this run's own place once Discord is back${pinging}. The owner is made a member of its thread then, or sent it in their DM when they cannot be or no place is found.` } };
    }
    if (alsoDmed === true) return { sent: { delivered: `Posted in this run's own place on Discord${pinging}; the owner could not be made a member of its thread, so it was sent to their DM as well.` } };
    if (alsoDmed === false) return { sent: { delivered: `Posted in this run's own place on Discord${pinging}; the owner could not be made a member of its thread, and their DM did not take it either, so they may not have been notified.` } };
    return { sent: { delivered: `Posted in this run's own place on Discord, where the owner is a member and is notified${pinging}; it is not also sent to their DM.` } };
  }
}

/** The key the open asks' Discord cards are kept under, by approval id. */
const KEPT_PROMPTS_KEY = "discord.prompts";
/** An ask lapses well within this; a record older is let go. */
const KEPT_PROMPTS_FOR_MS = 3 * 24 * 60 * 60_000;

type KeptPrompt = { summary: string; refs: PromptRef[]; at: number };

/** The kept cards, in the workspace's settings, pruned of what is past keeping each time they are written. */
function keptPromptsIn(kernel: Kernel): KeptPrompts {
  const all = (): Record<string, KeptPrompt> => kernel.settings.get<Record<string, KeptPrompt>>(KEPT_PROMPTS_KEY) ?? {};
  const save = (next: Record<string, KeptPrompt>): void => {
    const now = Date.now();
    kernel.settings.set(KEPT_PROMPTS_KEY, Object.fromEntries(Object.entries(next).filter(([, p]) => now - p.at < KEPT_PROMPTS_FOR_MS)));
  };
  return {
    get: (id) => all()[id],
    set: (id, prompt) => save({ ...all(), [id]: { ...prompt, at: Date.now() } }),
    delete: (id) => {
      const { [id]: _gone, ...rest } = all();
      save(rest);
    },
  };
}

/** The key the last message taken in each Discord room is kept under. */
const ROOM_CURSORS_KEY = "discord.cursors";

/** Where catch-up starts in each room, in the workspace's settings so a restart knows. */
export function roomCursorsIn(settings: { get<T>(key: string): T | undefined; set(key: string, value: unknown): void }): RoomCursors {
  const all = (): Record<string, string> => settings.get<Record<string, string>>(ROOM_CURSORS_KEY) ?? {};
  return {
    get: (room) => all()[room],
    advance: (room, id) => {
      const now = all();
      const at = now[room];
      if (at && BigInt(at) >= BigInt(id)) return;
      settings.set(ROOM_CURSORS_KEY, { ...now, [room]: id });
    },
    rooms: () => Object.keys(all()),
    drop: (room) => {
      const { [room]: _gone, ...rest } = all();
      settings.set(ROOM_CURSORS_KEY, rest);
    },
  };
}

/** The key the story lines of running turns are kept under. */
const KEPT_STORIES_KEY = "discord.stories";

/** The story lines of turns still running, in the workspace's settings, so a restart can say it cut them short. */
export function keptStoriesIn(settings: { get<T>(key: string): T | undefined; set(key: string, value: unknown): void }): KeptStories {
  const all = (): Record<string, PromptRef> => settings.get<Record<string, PromptRef>>(KEPT_STORIES_KEY) ?? {};
  return {
    add: (ref) => settings.set(KEPT_STORIES_KEY, { ...all(), [ref.messageId]: ref }),
    remove: (messageId) => {
      const { [messageId]: _gone, ...rest } = all();
      settings.set(KEPT_STORIES_KEY, rest);
    },
    take: () => {
      const refs = Object.values(all());
      settings.set(KEPT_STORIES_KEY, {});
      return refs;
    },
  };
}

export async function runHost(options: HostOptions): Promise<void> {
  keepRunning();
  let imessageAdapter: IMessageAdapter | undefined;
  let imessageClaim: HandleClaim | undefined;
  let imessageRuntime: ReturnType<typeof connectChannel> | undefined;
  const wantDiscord = options.discord !== false;
  const creds = discordCreds();
  if (options.requireDiscord && !creds) {
    throw new Error(
      "Discord required but KOS_SECRET_DISCORD/DISCORD_TOKEN and KOS_OWNER_DISCORD/DISCORD_OWNER_ID are not set",
    );
  }

  let runtime: ChannelRuntime | undefined;

  /*
   * The surfaces a message can be sent on, by name.
   *
   * A map of one today. It exists as a map because "which surface" is the
   * question the tool asks, and answering it by ignoring the name and using
   * the only adapter there is would make `to: "telegram"` arrive on Discord.
   * Adding a surface is a line here.
   */
  const surfaces = new Map<string, () => ChannelAdapter | undefined>();
  surfaces.set("discord", () => adapter);
  const sms = smsConfig();
  let smsAdapter: SmsAdapter | undefined;
  if (sms) surfaces.set("sms", () => smsAdapter);
  /** The surface a message goes to when none is named: the first one wired. */
  const defaultSurface = creds && wantDiscord ? "discord" : sms ? "sms" : "discord";
  const ownerOn = (surface: string): string => (surface === "sms" ? sms?.owner ?? "" : creds?.ownerId ?? "");

  /** A scheduled run's place on the server, once the server is laid out; unset without one. */
  let placer: PlaceNotifier | undefined;
  /** The scheduled job a conversation is the thread of, when it is one. */
  const cronOf = (conversationId: string) => (conversationId.startsWith("cron:") ? kernel.crons.get(Number(conversationId.slice("cron:".length))) : undefined);

  const notify =
    (creds && wantDiscord) || sms
      ? async (payload: NotifyPayload): Promise<NotifySent | undefined> => {
          const surface = payload.target.surface ?? defaultSurface;
          const msg = {
            text: payload.text,
            ...(payload.card ? { card: payload.card } : {}),
            ...(payload.buttons ? { buttons: payload.buttons } : {}),
            ...(payload.from ? { from: payload.from } : {}),
          };
          // A scheduled run that named nowhere speaks in its own place on the
          // server (the job's thread, the blob's channel) rather than the DM;
          // with no place to be had it reaches the owner as before, told why.
          const inPlace = await placer?.say(payload, msg);
          if (inPlace && "sent" in inPlace) return inPlace.sent;
          const send = surfaceUp(surfaces, surface, payload.target.surface !== undefined);
          // An addressed message goes through sendTo; the owner's DM is the
          // path everything took before and still takes. What a channel
          // post was given as an id comes back, so it can be reacted to.
          if (payload.target.kind === "owner") {
            await send.send(ownerOn(surface), msg);
            return inPlace ? { delivered: `Sent to the owner's DM: ${inPlace.dm}.` } : undefined;
          }
          const posted = await send.sendTo?.(payload.target, msg);
          return posted && typeof posted === "object" && typeof posted.id === "string" ? { id: posted.id } : undefined;
        }
      : undefined;

  let adapter: DiscordAdapter | undefined;
  /**
   * Lay the server out from what exists, and keep the thread bindings it
   * hands back: a thread carries no topic, so which chat it stands for is
   * the kernel's to remember, and the adapter is told so it does not make
   * the same thread twice.
   */
  const layOut = async (): Promise<Awaited<ReturnType<DiscordAdapter["sync"]>>> => {
    adapter!.rememberThreads(kernel.threadBindings());
    const made = await adapter!.sync(kernel.surfaceChannels());
    // Discord's permissions are the truth for who reads a channel; the kernel follows, so the guest gate agrees.
    for (const [key, audience] of Object.entries(made.audiences)) kernel.setChannelAudience(key, audience);
    adapter!.rememberThreads(kernel.threadBindings());
    return made;
  };

  /*
   * Computer use: devices the owner paired dial in and KOS drives them. Its
   * own package; the kernel only loads it as a module. KOS's key is kept
   * outside the workspace, so the agent never reads it, and outside the
   * KOS_SECRET_ names too, which the agent can put in a request.
   */
  /** A held action as a surface asks about it; `pictured` false leaves its picture unread, for a list that shows none. */
  const approvalRequest = (action: PendingAction, pictured = true): ApprovalRequest => {
    const picture = pictured && action.picture ? kernel.approvals.pictureOf(action.id) : undefined;
    const asker = kernel.askerOf(action.conversationId);
    return {
      id: String(action.id),
      text: `Approve ${action.tool}?`,
      tool: action.tool,
      args: action.args,
      reason: action.reason,
      expiresAt: approvalExpiry(action, kernel.behaviour()),
      // The card names what the ids are: #leetcode, not 1561643942586351626.
      names: (kind: string, id: string) => kernel.labelFor(kind, id),
      ...(picture ? { picture } : {}),
      ...(action.why ? { why: action.why } : {}),
      ...(asker ? { asker } : {}),
      ...(action.rule ? { rule: action.rule } : {}),
    };
  };
  /** What answers the panel's chat, and what it may be changed to: the dashboard picker's choices. */
  const panelModels = async (): Promise<{ current: string; choices: string[]; fixed?: string }> => {
    if (kernel.behaviour().engine === "sdk") return { current: "", choices: [], fixed: "Claude Agent SDK" };
    const current = kernel.routes()?.["reasoning"]?.model ?? "";
    const choices = await kernel.availableModels().catch((): string[] => []);
    return { current, choices: current && !choices.includes(current) ? [current, ...choices] : choices };
  };
  /** The chat a device panel shows (a Chrome's side panel, a Mac's window): its surface's current one, made only when the owner first speaks there. */
  const surfaceChat = (channel: PanelSurface) => (): { id: string; title: string } | undefined => {
    const owner = kernel.profile.ownerId;
    const id = activeOwnChat(kernel.conversations, channel, owner) ?? surfaceSessionId(channel, owner);
    return kernel.conversations.get(id) ? { id, title: kernel.titleOf(id) } : undefined;
  };
  const chromeChat = surfaceChat("chrome");
  const macChat = surfaceChat("mac");
  const phoneChat = surfaceChat("phone");
  /** Where a chat lives, as a device's chat list groups it: KOS at the root, a project, or a blob. */
  const placeOf = (c: { projectSlug: string | null; role: string | null }): PanelPlaceOf => {
    if (c.role) return { kind: "blob", name: kernel.labelFor("blob", c.role) ?? c.role };
    if (c.projectSlug) return { kind: "project", name: kernel.labelFor("project", c.projectSlug) ?? c.projectSlug };
    return { kind: "kos" };
  };
  /** What is going on in KOS, for a phone that asks: what runs, what waits on the owner, what fails, what fires next. */
  const glance = (): Glance => {
    const next = kernel.crons
      .list()
      .filter((job) => job.enabled)
      .flatMap((job) => kernel.cronNextRuns(job.id, 1).map((at) => ({ name: job.name, at })))
      .sort((a, b) => a.at - b.at)
      .slice(0, 5);
    const pending = kernel.approvals.pending();
    return {
      halted: kernel.killSwitch.halted,
      running: kernel.busyConversations().slice(0, 10).map((id) => ({ id, title: kernel.nameOf(id) })),
      waiting: pending.length,
      // Every one, each with its chat; the panel sends the first to lapse.
      asks: pending.map((action) => ({
        ...(action.conversationId ? { chat: { id: action.conversationId, title: kernel.nameOf(action.conversationId) } } : {}),
        // A glance sends no picture, so none is read for it.
        request: approvalRequest(action, false),
      })),
      failing: kernel.health.failing().slice(0, 10).map(({ label, streak, error, since }) => ({ label, streak, error, since })),
      next,
    };
  };
  /** An artifact as a device lists it: what the gallery says of it, and whose it is. */
  const artifactItem = (r: { id: string; title: string; artifactKind: string; description?: string; updatedAt: number; projectSlug: string | null; blob?: string }): PanelArtifact => ({
    id: r.id,
    title: r.title,
    kind: r.artifactKind,
    ...(r.description ? { description: r.description } : {}),
    updatedAt: r.updatedAt,
    place: r.blob ? { kind: "blob", name: r.blob } : r.projectSlug ? { kind: "project", name: kernel.labelFor("project", r.projectSlug) ?? r.projectSlug } : { kind: "kos" },
  });
  /** The owner's artifacts, for a phone to read: the HTML ones out of the trash, as the dashboard opens them, and only read. */
  const phoneArtifacts: PanelArtifacts = {
    recent: () =>
      kernel.pages
        .list()
        .filter((r) => r.kind === "html")
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(artifactItem),
    open: (id, theme) => {
      const view = kernel.artifactView(id, theme);
      return view && { ...artifactItem(view.record), document: view.document, themes: view.themes };
    },
    read: (id, method, args) => kernel.artifactCall(id, method, args),
  };
  /** What a device panel reads and does, for its own surface's chats and no one else's. */
  const panelDeps = (channel: PanelSurface, current: () => { id: string; title: string } | undefined): PanelDeps => ({
    current,
    ensure: () => {
      const made = kernel.conversationFor(channel, kernel.profile.ownerId);
      return { id: made.id, title: kernel.titleOf(made.id) };
    },
    // With each step's picture marked, as the dashboard's thread has them.
    events: (id) => withFrames(conversationEvents(kernel.sessions.get(id)), kernel.frames.listFor(id)),
    picture: (frameId) => kernel.frames.shown(frameId),
    waiting: (id) => kernel.approvals.pending().filter((a) => a.conversationId === id).map((a) => approvalRequest(a)),
    // The panel's own chats, as /chats there lists them: the surface's stream and the chats made from it, nothing else of the owner's.
    chats: () =>
      kernel.conversations
        .list(kernel.profile.ownerId)
        .filter((c) => c.channel === channel)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 40)
        .map((c) => ({ id: c.id, title: kernel.titleOf(c.id), updatedAt: c.updatedAt, place: placeOf(c) })),
    switchTo: (id) => {
      const c = kernel.conversations.get(id);
      if (c?.channel !== channel) return false;
      kernel.conversations.setActive(channel, kernel.profile.ownerId, id);
      return true;
    },
    // On the device line: a lookup that throws answers with nothing rather than taking the line's handler down.
    mentions: (q, kind) => {
      try {
        return mentionsOf(kernel, q, 8, kind).map(({ kind: k, id, label, hint }) => ({ kind: k, id, label, ...(hint ? { hint } : {}) }));
      } catch {
        return [];
      }
    },
    models: () => panelModels(),
    auto: (id) => kernel.actsWithoutAsking(id),
    setAuto: (id, on) => kernel.setActsWithoutAsking(id, on),
    // The dashboard's picker, merged rather than replacing: the route's effort and the cheap route stay as they were.
    setModel: async (model) => {
      const saved = parseModelSettings(kernel.settings.get(MODEL_SETTINGS_KEY));
      const next = { ...saved, reasoning: { ...saved.reasoning, model } };
      kernel.settings.set(MODEL_SETTINGS_KEY, next);
      kernel.applyModelSettings(next);
      return panelModels();
    },
  });
  const computer = createComputerUse({
    hostKeyPath: process.env.KOS_DEVICE_KEY_FILE?.trim() || join(homedir(), ".kos", "device-host.key"),
    ...(process.env.KOS_DEVICE_HOST_KEY ? { hostKeyEnv: process.env.KOS_DEVICE_HOST_KEY } : {}),
    // Read by KOS for Mac on this computer to prove it is here, so KOS may rebuild it (docs/computer.md, Builds and updates).
    localKeyPath: process.env.KOS_DEVICE_LOCAL_KEY_FILE?.trim() || join(homedir(), ".kos", "device-local.key"),
    caller: () => kernel.callerConversationId,
    // An ask to use a computer or a Chrome says who asks by the name it goes by everywhere.
    titleOf: (id) => kernel.nameOf(id),
    halted: () => kernel.killSwitch.halted,
    face: () => kernel.kosDrawing(),
    theme: () => kernel.dashboardTheme(),
    panels: {
      chrome: panelDeps("chrome", chromeChat),
      mac: panelDeps("mac", macChat),
      phone: {
        ...panelDeps("phone", phoneChat),
        glance,
        artifacts: phoneArtifacts,
        // The dashboard's own handler, with no token: the phone is proved on its line. Only a phone's panel is given it.
        dashboard: (req) => handleApiRequest(kernel, req, dashboard),
        audit: (entry) => void kernel.audit.record({ ...entry, userId: kernel.profile.ownerId }),
      },
    },
    lan: {
      // The dashboard's port plus two: the sites take plus one.
      port: lanPort(options.port),
      host: process.env.KOS_DEVICE_LAN_HOST?.trim() || "0.0.0.0",
      certPath: process.env.KOS_DEVICE_LAN_CERT_FILE?.trim() || join(homedir(), ".kos", "device-lan.pem"),
      forced: process.env.KOS_DEVICE_LAN === "1",
    },
    // A session started unasked is written down as the start it stands for.
    audit: (entry) => void kernel.audit.record(entry),
    // The owner's Stop on a device stops the chat's turn, as the dashboard's does.
    stopTurn: (id) => kernel.stop(id),
    // Each device app kept on the build this checkout holds: packages/cli/dist is two folders down from it.
    updates: deviceUpdates(fileURLToPath(new URL("../../..", import.meta.url)), (line) => console.error(line)),
  });

  // KOS's Chrome answers on 9225; a second KOS on the machine names another port.
  const browserPort = Number(process.env.KOS_BROWSER_PORT ?? "");

  const kernel = await Kernel.boot({
    rootDir: options.rootDir,
    allowedHosts: options.allowedHosts,
    ...(Number.isInteger(browserPort) && browserPort > 0 && browserPort < 65_536 ? { chrome: { port: browserPort } } : {}),
    extraModules: [computer.module],
    features: [{ name: "computer", description: "Use a paired computer: its screen, pointer and keyboard" }],
    ...(notify ? { notify } : {}),
    // The server's channels as tools, so KOS opens or closes one when the
    // owner says so. The adapter is made after boot; these reach for it then.
    // With --no-discord there is no server: no tools for it, and no upkeep chat.
    ...(wantDiscord && creds?.guildId
      ? {
          discord: {
            connected: () => adapter !== undefined,
            channels: async () => {
              const plan = kernel.surfaceChannels();
              const bound = new Set(Object.values(kernel.threadBindings()));
              const listening = kernel.channelListening();
              return (await adapter!.channels()).map((c) => {
                const planned = plan.find((p) => p.key === c.key);
                const threads = (planned?.threads ?? []).filter((t) => bound.has(t.conversationId)).length;
                return { ...c, ...(planned?.fixed ? { fixed: true } : {}), ...(threads ? { threads } : {}), ...(listening[c.key] ? { listen: listening[c.key]! } : {}) };
              });
            },
            setAudience: async (key, audience) => {
              kernel.setChannelAudience(key, audience);
              return adapter!.setAudience(key, audience);
            },
            // Kept by the kernel alone: Discord has no permission for "only when addressed".
            setListen: async (key, listen) => {
              kernel.setChannelListen(key, listen);
              const found = (await adapter!.channels()).find((c) => c.key === key);
              if (!found) throw new Error(`no channel bound to ${key}`);
              return { ...found, ...(listen === "mention" ? { listen } : {}) };
            },
            sync: async () => {
              const made = await layOut();
              return { created: made.created, kept: made.kept, threads: made.threads.length };
            },
            // The server beyond KOS's own layout: places and roles of the owner's.
            server: async () => ({ places: await adapter!.places(), roles: await adapter!.roles() }),
            make: (input) => adapter!.makePlace(input),
            createRole: (name, colour) => adapter!.createRole(name, colour),
            setAccess: (place, access) => adapter!.setAccess(place, access),
            // A channel of the owner's as a chat's home: the kernel keeps the
            // audience the channel's own permissions say, so the layout and
            // the guest gate agree with it.
            bind: async (channel, to) => {
              // A project's or a blob's home, or any chat of the owner's by its id.
              if (!/^(project|agent):/.test(to) && !kernel.conversations.get(to)) throw new Error(`no chat with id ${to}; chats.list gives ids`);
              const bound = await adapter!.bind(channel, to, kernel.titleOf(to));
              kernel.setChannelAudience(to, bound.audience);
              return { key: to, name: bound.name, audience: bound.audience };
            },
            known: () => adapter?.knownChannels() ?? [],
            threads: () => kernel.threadsBound(),
            prune: async (ids) => {
              const deleted: string[] = [];
              for (const id of ids) {
                if (await adapter!.deleteThread(id)) {
                  kernel.unbindThread(id);
                  deleted.push(id);
                }
              }
              return deleted;
            },
            react: (channel, message, emoji) => adapter!.react(channel, message, emoji),
            reactions: (channel, message) => adapter!.reactions(channel, message),
            messages: (channel, limit) => adapter!.messages(channel, limit),
            member: (id) => adapter!.member(id),
          },
        }
      : {}),
    // A restart asked for from Settings: `kos restart` run beside the host,
    // detached so it outlives the stop it does. The CLI already knows how
    // to stop this host and start the next, under launchd or not; the host
    // only has to not be mid-turn, which the kernel sees to.
    restart: async () => {
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL("./main.js", import.meta.url)), "restart", "--workspace", options.rootDir, "--host", options.host, "--port", String(options.port)],
        { detached: true, stdio: "ignore", env: process.env },
      );
      child.unref();
    },
    // Every surface the owner is on, and a device panel when its chat is the one asking.
    onApprovalRequested: (action) => {
      const request = approvalRequest(action);
      if (adapter && creds) void adapter.requestApproval(creds.ownerId, request);
      if (smsAdapter && sms) void smsAdapter.requestApproval(sms.owner, request);
      void computer.panel.requestApproval("owner", request);
      void computer.mac.requestApproval("owner", request);
      void computer.phone.requestApproval("owner", request);
    },
  });

  // A turn the last process was running when it stopped is said to be cut
  // short in its chat, before any surface can start a turn of its own.
  kernel.markInterrupted();
  // Off unless the owner set an interval; the timer re-reads it, so turning
  // it on in settings does not need a restart.
  kernel.startHeartbeat();
  // Whatever the owner left running stays running across a restart of the
  // host, the same way a schedule does.
  kernel.startDaemons();

  const staticDir = process.env.KOS_UI_DIST ?? defaultUiDist();
  const meta: {
    pid: number;
    discord: boolean;
    cron: boolean;
    workspace: string;
    imessage?: { state: "watching" | "skipped" | "failed"; detail?: string };
  } = {
    pid: process.pid,
    discord: false,
    cron: true,
    workspace: kernel.workspace.root,
  };

  /** The dashboard as the server answers it, but for the token, which a phone's asks of it go without. */
  const dashboard: DashboardServerOptions = {
    ...(staticDir ? { staticDir } : {}),
    // So the settings page can save an API key without anyone opening a
    // dotfile. Refused if it ever resolves inside the workspace.
    envPath: envFilePath(),
    ...(options.hookSecret ? { hookSecret: options.hookSecret } : {}),
    host: options.host,
    meta,
    extensions: [computer.routes],
    ...(sms
      ? {
          smsInbound: async ({ url, params, signature }) => {
            // Signed over the URL Twilio was given, which a tunnel or proxy
            // may hide from the request; the owner can say it outright.
            const signedUrl = sms.publicUrl ? `${sms.publicUrl.replace(/\/$/, "")}/api/sms/inbound` : url;
            if (!verifyTwilioSignature(signedUrl, params, signature, sms.authToken)) return false;
            if (smsAdapter) await smsAdapter.receive(params);
            return true;
          },
        }
      : {}),
  };
  const server = createDashboardServer(kernel, { ...dashboard, ...(options.token ? { token: options.token } : {}) });

  // A chat that borrowed the owner's Chrome browses there.
  kernel.setBrowserElsewhere(computer.chrome);

  // The two upgrades the dashboard server takes: the dashboard's own socket, and a paired device's.
  const live = createDashboardSocket(kernel, { ...(options.token ? { token: options.token } : {}) });
  server.on("upgrade", (req, socket, head) => {
    if (!live.upgrade(req, socket, head) && !computer.upgrade(req, socket, head)) socket.destroy();
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `port ${options.port} is already in use. Stop the other host (kos stop) or pick --port`,
          ),
        );
      } else {
        reject(err);
      }
    });
    server.listen(options.port, options.host, () => resolveListen());
  });

  writeDaemonState({
    pid: process.pid,
    host: options.host,
    port: options.port,
    workspace: kernel.workspace.root,
    startedAt: new Date().toISOString(),
    discord: false,
  });

  const sitesPort = options.sitesPort ?? options.port + 1;
  let siteServer: Server | undefined;
  if (sitesPort > 0) {
    try {
      siteServer = startSiteServer(kernel.workspace, sitesPort, options.host);
      // So sites.list can tell the agent where its work ended up.
      process.env.KOS_SITES_URL = `http://${options.host}:${sitesPort}`;
      await new Promise<void>((resolveListen, reject) => {
        siteServer?.once("error", reject);
        siteServer?.once("listening", () => resolveListen());
      });
    } catch (err) {
      // Not being able to show you a site is a smaller problem than the host
      // refusing to start, so it is reported and stepped over.
      siteServer = undefined;
      delete process.env.KOS_SITES_URL;
      console.log(`sites: not served (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  console.log(`KOS host on http://${options.host}:${options.port}`);
  if (options.hookSecret) console.log("hooks: POST /api/hooks/<job name>");
  console.log(`workspace: ${kernel.workspace.root}`);
  console.log(`session: ${primarySessionId(kernel.profile.ownerId)}`);
  if (siteServer) console.log(`sites: http://${options.host}:${sitesPort}`);
  if (staticDir) console.log(`ui: ${staticDir}`);
  else console.log("ui: not built (pnpm -C packages/ui build); API only");

  if (wantDiscord && creds) {
    // Where a reference in a reply, or a chat a slash command names, links
    // to: the public URL when there is one; otherwise this host, which is
    // right on the machine it runs on.
    const dashboardUrl = dashboardUrlFor(options.host, options.port);
    adapter = new DiscordAdapter({
      token: creds.token,
      ownerId: creds.ownerId,
      dashboardUrl,
      ...(creds.guildId ? { guildId: creds.guildId } : {}),
      // Which thread stands for which chat: the kernel keeps it, the adapter asks.
      threadOf: (threadId) => kernel.threadBindings()[threadId],
      // Each open ask's cards, kept in the workspace so a restart still settles both.
      keptPrompts: keptPromptsIn(kernel),
      // What each room last said to KOS, so what was said while it was away is caught up.
      cursors: roomCursorsIn(kernel.settings),
      // Each running turn's story line, so one a restart cut short says so.
      keptStories: keptStoriesIn(kernel.settings),
      // A thread deleted on Discord lets its chat go; it gets a new one on next use.
      onGone: (id) => {
        if (kernel.threadBindings()[id]) kernel.unbindThread(id);
      },
      // A thread made for a chat is the chat's at once, before another post could make a second.
      onThreadMade: (threadId, conv) => kernel.bindThread(threadId, conv),
      // The owner renamed a chat's thread on Discord: the chat takes the name.
      onThreadRenamed: (threadId, name) => {
        const id = kernel.threadBindings()[threadId];
        const chat = id ? kernel.conversations.get(id) : undefined;
        if (chat && chat.title !== name) kernel.conversations.rename(chat.id, name);
      },
      threadBindings: () => kernel.threadBindings(),
      timezone: kernel.profile.timezone,
      labelOf: (kind, id) => kernel.labelFor(kind, id),
      // A channel the owner opened to guests takes what its members say.
      guestsAllowed: (key) => kernel.channelAudiences()[key] === "guests",
      // Run now from Discord: the same path as the dashboard, so the result shows on both.
      onRunCron: async (id) => {
        const job = kernel.crons.get(id);
        if (!job) return undefined;
        try {
          const r = await kernel.fireCron(id);
          if (!r.outcome.fired) {
            // Did not start: say why in words, not as a failure of the job.
            const why =
              r.outcome.reason === "halted"
                ? "KOS is halted by the kill switch"
                : r.outcome.reason === "rate_limited"
                  ? "this hour's limit on self-prompting jobs is reached"
                  : r.error;
            return { name: job.name, ok: false, fired: false, ...(why ? { error: why } : {}) };
          }
          return { name: job.name, ok: r.ok, fired: true, ...(r.error ? { error: r.error } : {}) };
        } catch (err) {
          return { name: job.name, ok: false, fired: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
      // A channel the owner set to listen on mention reaches its chat only when addressed.
      listenOf: (key) => kernel.channelListening()[key] ?? "always",
      // Who speaks from a chat, so a blob's story in its channel is the blob's.
      senderOf: (conversationId) => kernel.senderFor(conversationId),
      // Back from a drop: an ask made while the gateway was down, or whose
      // card never went out, gets one now.
      onConnected: async () => {
        for (const action of kernel.approvals.pending()) {
          if (!adapter!.hasCard(String(action.id))) await adapter!.requestApproval(creds.ownerId, approvalRequest(action)).catch(() => undefined);
        }
      },
    });
    /*
     * A button KOS sent comes back as a message.
     *
     * Rather than a second way for a surface to drive the agent, the press is
     * turned into what the owner would have typed and handed to the ordinary
     * turn machinery, in the conversation recorded when the button went out.
     * The reply goes back the way any reply does.
     */
    /*
     * Settling a prompt decided elsewhere is ChannelRuntime's job, for any
     * surface that can do it, and it releases the subscription on stop. It
     * was wired a second time here, which the prompt registry made harmless
     * but did not make correct.
     */

    /*
     * The slash commands, answered by this process.
     *
     * Bookkeeping the daemon already knows: where messages go, what threads
     * exist, stopping a turn. None of it reaches the model, so none of it
     * costs a turn.
     */
    adapter.onCommand({
      // The jobs /run can fire, by id: the owner's first, then KOS's own, as the Schedule page lists them.
      jobs: () => {
        const all = kernel.crons.list().map((j) => ({ id: j.id, name: j.name, enabled: j.enabled }));
        return [...all.filter((j) => !j.name.startsWith("kos.")), ...all.filter((j) => j.name.startsWith("kos."))];
      },
      list: () =>
        kernel.conversations
          .list(kernel.profile.ownerId)
          .map((c) => ({
            id: c.id,
            title: c.title,
            kind: conversationKind(c, kernel.profile.ownerId),
          }))
          // A schedule's thread is a record of its runs, not somewhere to be
          // sent, and the router routes rather than being talked at.
          .filter((c) => c.kind === "chat" || c.kind === "surface"),
      current: () =>
        kernel.conversations.activeFor(adapter!.name, kernel.profile.ownerId),
      target: (id) =>
        kernel.conversations.setActive(adapter!.name, kernel.profile.ownerId, id),
      home: () => surfaceSessionId(adapter!.name, kernel.profile.ownerId),
      stop: (id) => kernel.stop(id),
      // Where to read a thread: the same dashboard the replies link to.
      link: (id) => `${dashboardUrl.replace(/\/+$/, "")}/#/chats/${encodeURIComponent(id)}`,
      create: (title) => {
        const made = kernel.conversations.create({
          userId: kernel.profile.ownerId,
          title,
        });
        return { id: made.id, title: made.title };
      },
    });

    adapter.onButton(
      createPressHandler({
        kernel,
        // The surface the answer is going to, so a card comes back as a card.
        channel: adapter.name,
        ownerRecipientId: creds.ownerId,
      }),
    );
    runtime = connectChannel(adapter, kernel, {
      ownerRecipientId: creds.ownerId,
      // A chat with a channel or thread gets its answers there, a decision's included.
      answeredElsewhere: (conversationId) => adapter?.mirrorTarget(conversationId, kernel.threadBindings()) !== undefined,
      // The sender->user table, seeded from config: only the configured Discord
      // account maps to a KOS user, so every other DM and button click is
      // dropped. Multi-user is more rows here, not a code change.
      identity: new AllowlistMapping(
        [{ channel: adapter.name, senderId: creds.ownerId }],
        kernel.profile.ownerId,
      ),
    });
    await runtime.start();
    meta.discord = true;
    writeDaemonState({
      pid: process.pid,
      host: options.host,
      port: options.port,
      workspace: kernel.workspace.root,
      startedAt: new Date().toISOString(),
      discord: true,
    });
    console.log("Discord: listening for DMs");
    /*
     * The bot wears KOS's own face, as set under Settings, Appearance, and
     * is given it again only when the look changes: Discord allows an
     * avatar to change a few times an hour, not on every check.
     */
    const wear = async (): Promise<void> => {
      const face = kernel.faceToWear();
      if (!face) return;
      try {
        await adapter!.wearFace(face.png);
        kernel.wearFace(face.hash);
      } catch (err) {
        console.warn(`Discord: the bot could not be given KOS's face: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    await wear();
    if (creds.guildId) {
      /*
       * The server mirrors the dashboard: a channel per project and per
       * blob, one for KOS, one for approvals. Made at start and kept in step
       * every few minutes, so a project or a blob made today has its channel
       * without a restart. Missing rights (Manage Channels, Manage Webhooks)
       * are said once, and KOS goes on as a DM.
       */
      const sync = async (first: boolean): Promise<void> => {
        if (!first) await wear();
        try {
          const made = await layOut();
          if (first || made.created.length || made.threads.length) {
            console.log(
              `Discord: server ready, ${made.kept.length} channels kept, ${made.created.length} made${made.created.length ? ` (${made.created.join(", ")})` : ""}, ${made.threads.length} threads made`,
            );
          }
        } catch (err) {
          if (first) console.error(`Discord: could not set the server up: ${err instanceof Error ? err.message : String(err)}`);
        }
      };
      // One layout at a time: two at once would each make the channel the other is making.
      let laying: Promise<void> = Promise.resolve();
      const syncOnce = (first: boolean): Promise<void> => (laying = laying.then(() => sync(first)));
      await syncOnce(true);
      setInterval(() => void syncOnce(false), 5 * 60_000).unref();
      // A project or a blob made now has its channel now, not at the next look.
      kernel.bus.on("chat:created", ({ conversationId }) => {
        if (/^(project|agent):/.test(conversationId)) void syncOnce(false);
      });
      /*
       * The server shows every exchange, wherever it happened, as it happens.
       * A turn taken on the dashboard, handed off, or dispatched by an
       * orchestrator lands in the channel or thread for that chat: the
       * incoming message when the turn starts (the thread made on demand if
       * it is not there yet), the steps narrated in place, the answer when it
       * is ready. A turn that came in from Discord is already shown there and
       * is left to the presence running it; a scheduled job posts its one
       * result under its own name through the handler below.
       */
      /** The files that came with words, read back from where the kernel kept them; one that is gone is dropped. */
      const keptFiles = (files: { name: string; path: string }[]) =>
        files.flatMap((f) => {
          try {
            return [{ name: f.name, mediaType: "application/octet-stream", data: readFileSync(kernel.workspace.resolve(f.path)).toString("base64"), path: f.path }];
          } catch {
            return [];
          }
        });
      /** Where a chat's thread goes: a project's under its channel, a root chat's or schedule's under #kos. */
      const homeOf = (conv: string): string | undefined => {
        try {
          return kernel.threadHome(conv);
        } catch {
          return undefined;
        }
      };
      const placeOn: PlaceDeps = {
        targetFor: (conv) => adapter?.mirrorTarget(conv, kernel.threadBindings()),
        homeOf,
        titleOf: (conv) => kernel.titleOf(conv),
        ensureThread: (key, conv, title) => adapter!.ensureThread(key, conv, title),
        joinOwner: (placeId) => adapter!.joinOwner(placeId),
        forgetPlace: (placeId) => adapter!.forgetPlace(placeId),
        postIn: (target, msg) => adapter!.postIn(target, msg),
        connected: () => adapter!.connected(),
        postWhenFound: (find, msg) => adapter!.postWhenFound(find, msg),
      };
      // A thread is read by whoever reads its channel: the chat's own (a room's by its place's), else its home's.
      const ownerOnly = (conv: string): boolean => {
        const home = homeOf(conv);
        return (kernel.audienceOf(conv) ?? (home ? kernel.channelAudiences()[home] : undefined) ?? "owner") === "owner";
      };
      const placed = new PlaceNotifier({
        ...placeOn,
        ownerId: creds.ownerId,
        // By the job the run named, so a blob's run in the blob's channel is known as its job's too.
        jobOf: (payload) => (payload.job !== undefined ? kernel.crons.get(payload.job) : payload.place ? cronOf(payload.place) : undefined),
        ownerOnly,
        sendOwner: (msg) => adapter!.send(creds.ownerId, msg),
      });
      placer = placed;
      const mirror = new ThreadMirror({
        targetFor: (conv) => adapter?.mirrorTarget(conv, kernel.threadBindings()),
        ownerOnly,
        homeOf,
        ensureThread: (key, conv, title) => adapter!.ensureThread(key, conv, title),
        titleOf: (conv) => kernel.titleOf(conv),
        speakerFor: (from) => kernel.speakerFor(from),
        ownerSender: () => adapter!.ownerSender(),
        senderFor: (conv) => kernel.senderFor(conv),
        filesFor: keptFiles,
        postIn: (target, msg) => adapter!.postIn(target, msg),
        openStory: (target, from) => adapter!.openStory(target, from),
        warn: (message) => console.warn(`[discord] thread mirror: ${message}`),
      });
      kernel.progress.subscribe((event) => {
        // A new turn has said nothing in its place yet.
        if (event.kind === "turn-start") placed.turnStarted(event.conversationId);
        mirror.onProgress(event);
      });
      const saidDeps: SaidDeps = {
        ...placeOn,
        jobOf: cronOf,
        ownerOnly,
        saidItsPiece: (conv) => placed.saidItsPiece(conv),
        senderFor: (conv) => kernel.senderFor(conv),
        speakerFor: (from) => kernel.speakerFor(from),
        ownerSender: () => adapter!.ownerSender(),
        filesFor: keptFiles,
        sendOwner: (msg) => adapter!.send(creds.ownerId, msg),
      };
      /*
       * A turn's exchange, told once it has happened. The mirror handles the
       * turns it has been narrating in a thread (it posts the answer and
       * closes the story); everything else, a scheduled job's result or a
       * resumed Discord turn, runs the handler below.
       */
      kernel.bus.on("turn:said", (said) => {
        if (!adapter) return;
        mirror.onSaid(said, () => postSaid(said, saidDeps));
      });
      // A slash command typed on the dashboard is a small line in the chat's
      // channel or thread, with the first line of what it answered.
      kernel.bus.on("command:ran", async (ran) => {
        // Not into a place guests read: the owner's bookkeeping is the owner's.
        if (ran.channel === "discord" || !adapter || !ownerOnly(ran.conversationId)) return;
        const target = adapter.mirrorTarget(ran.conversationId, kernel.threadBindings());
        if (!target) return;
        const answer = ran.reply.trim().split("\n")[0] ?? "";
        await adapter.postIn(target, { text: `-# \`${ran.text.replace(/`/g, "'")}\` · you, on the dashboard${answer ? `\n-# ${answer.slice(0, 300)}` : ""}` });
      });
      // A chat renamed anywhere names its thread the same.
      kernel.bus.on("chat:renamed", async ({ conversationId, title }) => {
        const threadId = Object.entries(kernel.threadBindings()).find(([, id]) => id === conversationId)?.[0];
        if (!threadId || !adapter) return;
        await adapter.renameThread(threadId, title).catch((err: unknown) => console.warn(`[discord] thread ${threadId} not renamed: ${err instanceof Error ? err.message : String(err)}`));
      });
      // A chat deleted on the dashboard takes its thread with it.
      kernel.bus.on("chat:deleted", async ({ conversationId }) => {
        if (!adapter) return;
        // A channel bound to it by topic is let go too, so it cannot make the chat again.
        await adapter.unbindChannel(conversationId).catch((err: unknown) => console.warn(`[discord] channel for ${conversationId} not let go: ${err instanceof Error ? err.message : String(err)}`));
        const threadId = Object.entries(kernel.threadBindings()).find(([, id]) => id === conversationId)?.[0];
        if (!threadId) return;
        await adapter.deleteThread(threadId).catch((err: unknown) => {
          console.warn(`[discord] thread ${threadId} for ${conversationId} not deleted: ${err instanceof Error ? err.message : String(err)}`);
        });
        kernel.unbindThread(threadId);
      });
    } else {
      // No server to lay out: only the face to keep up.
      setInterval(() => void wear(), 5 * 60_000).unref();
    }
  } else if (wantDiscord && !creds) {
    console.log(
      "Discord: skipped (set DISCORD_TOKEN + KOS_OWNER_DISCORD to enable)",
    );
  }

  let smsRuntime: ReturnType<typeof connectChannel> | undefined;
  if (sms) {
    smsAdapter = new SmsAdapter({
      accountSid: sms.accountSid,
      authToken: sms.authToken,
      from: sms.from,
      owner: sms.owner,
      ...(sms.publicUrl ? { publicUrl: sms.publicUrl } : {}),
      report: (m) => console.log(m),
      timezone: kernel.profile.timezone,
    });
    smsRuntime = connectChannel(smsAdapter, kernel, {
      ownerRecipientId: sms.owner,
      identity: new AllowlistMapping([{ channel: smsAdapter.name, senderId: sms.owner }], kernel.profile.ownerId),
    });
    await smsRuntime.start();
    console.log(`SMS: texts to ${sms.from} from your number arrive at POST /api/sms/inbound`);
  }

  /*
   * iMessage, when the owner has said which thread.
   *
   * Its own runtime rather than a branch of Discord's: the two surfaces are
   * independent, and a Mac with no Messages set up should lose iMessage and
   * keep everything else.
   */
  const imessage = imessageConfig();
  if (imessage) {
    const claim = claimHandle(imessage.handle);
    if (!existsSync(imessage.dbPath)) {
      meta.imessage = { state: "skipped", detail: `no database at ${imessage.dbPath}` };
      console.log(`iMessage: skipped (no database at ${imessage.dbPath})`);
    } else if (!claim.ok) {
      meta.imessage = { state: "skipped", detail: `pid ${claim.heldBy} is already watching that thread` };
      /*
       * Two hosts on one thread answer each other forever, and every lap is
       * two real messages and two turns. Better to run without the surface
       * and say why.
       */
      console.log(
        `iMessage: skipped (pid ${claim.heldBy} is already watching that thread)`,
      );
    } else {
      imessageClaim = claim.claim;
      try {
        imessageAdapter = new IMessageAdapter({
          handle: imessage.handle,
          dbPath: imessage.dbPath,
          timezone: kernel.profile.timezone,
        });
        imessageRuntime = connectChannel(imessageAdapter, kernel, {
          ownerRecipientId: imessage.handle,
          // The same rule as Discord: one sender maps to the owner and
          // nothing else reaches the agent.
          identity: new AllowlistMapping(
            [{ channel: imessageAdapter.name, senderId: imessage.handle }],
            kernel.profile.ownerId,
          ),
        });
        await imessageRuntime.start();
        meta.imessage = { state: "watching" };
        console.log("iMessage: watching your own thread");
      } catch (err) {
        // Full Disk Access not granted, a locked database, Messages not set
        // up: none of them are a reason for the host to refuse to start.
        // Said in words that name the fix, here and on the status the
        // dashboard shows.
        imessageAdapter = undefined;
        imessageRuntime = undefined;
        imessageClaim?.release();
        imessageClaim = undefined;
        const detail = describeStartFailure(err, process.execPath);
        meta.imessage = { state: "failed", detail };
        console.log(`iMessage: not started. ${detail}`);
      }
    }
  }

  /*
   * The side panel of each paired Chrome, the window of each paired Mac and
   * the chat of each paired phone:
   * surfaces of their own, whatever else is wired, and quiet until a device
   * is paired with computer use on. A turn one did not take (one on the
   * dashboard, one from another of the owner's Chromes) is told there as it
   * goes, as Discord's thread is.
   */
  const panelRuntimes: { stop(): Promise<void> }[] = [];
  for (const panel of [computer.panel, computer.mac, computer.phone]) {
    const runtime = connectChannel(panel, kernel, { ownerRecipientId: "owner", identity: panel.identity(kernel.profile.ownerId) });
    await runtime.start();
    panelRuntimes.push(runtime);
    kernel.progress.subscribe((event) => panel.watch(event));
  }

  /*
   * The schedule starts once every surface is wired, not before. A job that
   * fell due while KOS was down runs the moment it is caught up, and when
   * that happened ahead of Discord's login its "tell me" found no surface:
   * the job was marked failing, the caretaker opened a fix chat for it, and
   * the chat found nothing wrong, at a model turn's cost, on every restart.
   */
  // What was waiting behind a turn when the last process stopped runs now,
  // or is named in its chat to send again.
  kernel.replayQueued();
  kernel.startCron();
  // A job whose moment passed while nothing was running did not happen and
  // said nothing. At most one run each, however many were missed.
  const caught = kernel.catchUpCron();
  if (caught > 0) {
    console.log(`cron: ran ${caught} job${caught === 1 ? "" : "s"} that fell due while KOS was down`);
  }

  console.log("Attach with: kos   |  stop with: kos stop");

  const shutdown = (): void => {
    console.log("shutting down…");
    clearDaemonState(kernel.workspace.root);
    void computer.close();
    live.close();
    server.close();
    void (async () => {
      try {
        if (runtime) await runtime.stop();
        if (smsRuntime) await smsRuntime.stop();
        if (imessageRuntime) await imessageRuntime.stop();
        for (const panelRuntime of panelRuntimes) await panelRuntime.stop();
        imessageClaim?.release();
        await kernel.closeBrowser();
      } catch {
        // ignore
      }
      kernel.close();
      process.exit(0);
    })();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}


/**
 * Wait for a listening socket to be released.
 *
 * cmdStop already waits for the process to die, but the pid going away and the
 * port becoming bindable are not the same instant. Starting into a port that
 * is still held fails with "already in use", which is exactly the race a
 * restart command exists to avoid.
 */
export async function waitForPortFree(
  host: string,
  port: number,
  timeoutMs = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const inUse = await new Promise<boolean>((resolve) => {
      const socket = connect({ host, port });
      const done = (busy: boolean): void => {
        socket.destroy();
        resolve(busy);
      };
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
      socket.setTimeout(500, () => done(false));
    });
    if (!inUse) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

