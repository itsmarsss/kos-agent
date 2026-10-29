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
  IMessageAdapter,
  describeStartFailure,
  SmsAdapter,
  verifyTwilioSignature,
  Kernel,
  connectChannel,
  conversationKind,
  createDashboardServer,
  createPressHandler,
  primarySessionId,
  surfaceSessionId,
  startSiteServer,
  SurfaceDownError,
  type NotifyPayload,
} from "@kos/harness";

import { envFilePath } from "./env.js";
import { ThreadMirror } from "./threadmirror.js";
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

  const notify =
    (creds && wantDiscord) || sms
      ? async (payload: NotifyPayload) => {
          const wanted = payload.target.surface;
          const connected = [...surfaces.keys()].filter((name) =>
            surfaces.get(name)!(),
          );
          if (wanted && !surfaces.has(wanted)) {
            throw new Error(
              `no ${wanted} surface here. Connected: ${connected.join(", ") || "none"}.`,
            );
          }
          // No surface named means wherever the owner already is: the
          // first one wired.
          const surface = wanted ?? defaultSurface;
          const send = surfaces.get(surface)?.();
          if (!send) throw new SurfaceDownError(surface, connected);
          const msg = {
            text: payload.text,
            ...(payload.card ? { card: payload.card } : {}),
            ...(payload.buttons ? { buttons: payload.buttons } : {}),
            ...(payload.from ? { from: payload.from } : {}),
          };
          // An addressed message goes through sendTo; the owner's DM is the
          // path everything took before and still takes. What a channel
          // post was given as an id comes back, so it can be reacted to.
          if (payload.target.kind === "owner") {
            await send.send(ownerOn(surface), msg);
            return undefined;
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
    for (const t of made.threads) kernel.bindThread(t.threadId, t.conversationId);
    // Discord's permissions are the truth for who reads a channel; the kernel follows, so the guest gate agrees.
    for (const [key, audience] of Object.entries(made.audiences)) kernel.setChannelAudience(key, audience);
    adapter!.rememberThreads(kernel.threadBindings());
    return made;
  };

  const kernel = await Kernel.boot({
    rootDir: options.rootDir,
    allowedHosts: options.allowedHosts,
    ...(notify ? { notify } : {}),
    // The server's channels as tools, so KOS opens or closes one when the
    // owner says so. The adapter is made after boot; these reach for it then.
    ...(creds?.guildId
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
    ...((creds && wantDiscord) || sms
      ? {
          onApprovalRequested: (action) => {
            const picture = action.picture ? kernel.approvals.pictureOf(action.id) : undefined;
            const asker = kernel.askerOf(action.conversationId);
            const request = {
              id: String(action.id),
              text: `Approve ${action.tool}?`,
              tool: action.tool,
              args: action.args,
              reason: action.reason,
              // The card names what the ids are: #leetcode, not 1561643942586351626.
              names: (kind: string, id: string) => kernel.labelFor(kind, id),
              ...(picture ? { picture } : {}),
              ...(action.why ? { why: action.why } : {}),
              ...(asker ? { asker } : {}),
            };
            if (adapter && creds) void adapter.requestApproval(creds.ownerId, request);
            if (smsAdapter && sms) void smsAdapter.requestApproval(sms.owner, request);
          },
        }
      : {}),
  });

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

  const server = createDashboardServer(kernel, {
    ...(staticDir ? { staticDir } : {}),
    // So the settings page can save an API key without anyone opening a
    // dotfile. Refused if it ever resolves inside the workspace.
    envPath: envFilePath(),
    ...(options.token ? { token: options.token } : {}),
    ...(options.hookSecret ? { hookSecret: options.hookSecret } : {}),
    host: options.host,
    meta,
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
    adapter = new DiscordAdapter({
      token: creds.token,
      ownerId: creds.ownerId,
      // Where a reference in a reply links to. The public URL when there is
      // one; otherwise this host, which is right on the machine it runs on.
      dashboardUrl: process.env.KOS_PUBLIC_URL?.trim() || `http://${options.host === "0.0.0.0" ? "localhost" : options.host}:${options.port}`,
      ...(creds.guildId ? { guildId: creds.guildId } : {}),
      // Which thread stands for which chat: the kernel keeps it, the adapter asks.
      threadOf: (threadId) => kernel.threadBindings()[threadId],
      threadBindings: () => kernel.threadBindings(),
      timezone: kernel.profile.timezone,
      labelOf: (kind, id) => kernel.labelFor(kind, id),
      // A channel the owner opened to guests takes what its members say.
      guestsAllowed: (key) => kernel.channelAudiences()[key] === "guests",
      // Run now from Discord: the same path as the dashboard, so the result shows on both.
      onRunCron: async (id) => {
        const job = kernel.crons.get(id);
        if (!job) return undefined;
        const r = await kernel.fireCron(id);
        return { name: job.name, ok: r.ok, ...(r.error ? { error: r.error } : {}) };
      },
      // A channel the owner set to listen on mention reaches its chat only when addressed.
      listenOf: (key) => kernel.channelListening()[key] ?? "always",
      // Who speaks from a chat, so a blob's story in its channel is the blob's.
      senderOf: (conversationId) => kernel.senderFor(conversationId),
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
      // Where to read a thread. The dashboard is on this machine, so this is
      // a link the owner can actually follow from Discord on the same one.
      link: (id) =>
        `http://${options.host}:${options.port}/#/chats/${encodeURIComponent(id)}`,
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
      await sync(true);
      setInterval(() => void sync(false), 5 * 60_000).unref();
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
      const mirror = new ThreadMirror({
        targetFor: (conv) => adapter?.mirrorTarget(conv, kernel.threadBindings()),
        projectOf: (conv) => {
          try {
            return kernel.conversations.get(conv)?.projectSlug ?? undefined;
          } catch {
            return undefined;
          }
        },
        ensureThread: (key, conv, title) => adapter!.ensureThread(key, conv, title),
        bindThread: (threadId, conv) => kernel.bindThread(threadId, conv),
        titleOf: (conv) => kernel.titleOf(conv),
        speakerFor: (from) => kernel.speakerFor(from),
        ownerSender: () => adapter!.ownerSender(),
        senderFor: (conv) => kernel.senderFor(conv),
        filesFor: (files) =>
          files.flatMap((f) => {
            try {
              return [{ name: f.name, mediaType: "application/octet-stream", data: readFileSync(kernel.workspace.resolve(f.path)).toString("base64"), path: f.path }];
            } catch {
              return [];
            }
          }),
        postIn: (target, msg) => adapter!.postIn(target, msg),
        openStory: (target) => adapter!.openStory(target),
        warn: (message) => console.warn(`[discord] thread mirror: ${message}`),
      });
      kernel.progress.subscribe((event) => mirror.onProgress(event));
      /*
       * A turn's exchange, told once it has happened. The mirror handles the
       * turns it has been narrating in a thread (it posts the answer and
       * closes the story); everything else, a scheduled job's result or a
       * resumed Discord turn, runs the handler below.
       */
      kernel.bus.on("turn:said", (said) => {
        if (!adapter) return;
        mirror.onSaid(said, async () => {
          if (!adapter) return;
        // A turn from Discord is answered by the presence that took it; one
        // that waited on an approval was answered "waiting on you" there, and
        // the answer after the decision has only this way back.
        if (said.channel === "discord" && !said.resumed) return;
        // A scheduled run of a project's job shows in the project's channel,
        // under the job's name: a daily post is what a schedule is for.
        const job = said.conversationId.startsWith("cron:") ? kernel.crons.get(Number(said.conversationId.slice("cron:".length))) : undefined;
        if (job) {
          /*
           * A scheduled run goes to the job's own thread: the same
           * conversation the dashboard shows its runs in, so the two stay in
           * sync and the project channel stays the orchestrator's. A job made
           * since the last layout gets its thread now; failing that, the
           * project's channel. The nudge itself reaches the owner through the
           * job's notify, not this record.
           */
          let where = adapter.mirrorTarget(said.conversationId, kernel.threadBindings());
          if (!where && job.projectSlug) {
            where = await adapter.ensureThread(`project:${job.projectSlug}`, said.conversationId, job.name).catch(() => undefined);
            if (where) kernel.bindThread(where, said.conversationId);
          }
          where ??= job.projectSlug ? adapter.mirrorTarget(`project:${job.projectSlug}`, kernel.threadBindings()) : undefined;
          // The result, with a Run now button so the owner can fire the job
          // again from here; it runs the same path the dashboard's Run now does.
          if (where && said.reply.trim()) await adapter.postIn(where, { text: `-# ${job.name}\n${said.reply}`, buttons: [{ label: "Run now", cron: job.id }] });
          return;
        }
        const target = adapter.mirrorTarget(said.conversationId, kernel.threadBindings());
        if (!target) return;
        const from = kernel.senderFor(said.conversationId);
        if (said.origin === "owner" && said.text.trim() && said.channel !== "discord") {
          // The files that came with the words go too, read back from where
          // the kernel kept them; one that is gone is simply not shown.
          const files = said.files.flatMap((f) => {
            try {
              return [{ name: f.name, mediaType: "application/octet-stream", data: readFileSync(kernel.workspace.resolve(f.path)).toString("base64"), path: f.path }];
            } catch {
              return [];
            }
          });
          if (said.from) {
            // Passed on by a chat or a schedule: under that sender's name and
            // face, which say who; the line says only what they cannot, that
            // it was passed on. A dispatched message is asked as the owner,
            // so it used to wear the owner's name and picture here.
            const speaker = kernel.speakerFor(said.from);
            await adapter.postIn(target, { text: `${said.text.trim()}\n-# passed on`, from: speaker, ...(files.length ? { files } : {}) });
          } else {
            // As the owner, under their own name and picture, so the thread
            // reads as the conversation it is; quoted by the bot only when the
            // owner cannot be looked up.
            const owner = await adapter.ownerSender();
            const text = owner ? said.text.trim() : `${said.text.trim().split("\n").map((l) => `> ${l}`).join("\n")}\n-# you, on the dashboard`;
            await adapter.postIn(target, { text, ...(owner ? { from: owner } : {}), ...(files.length ? { files } : {}) });
          }
        }
        if (said.reply.trim()) await adapter.postIn(target, { text: said.reply, ...(from ? { from } : {}) });
        });
      });
      // A slash command typed on the dashboard is a small line in the chat's
      // channel or thread, with the first line of what it answered.
      kernel.bus.on("command:ran", async (ran) => {
        if (ran.channel === "discord" || !adapter) return;
        const target = adapter.mirrorTarget(ran.conversationId, kernel.threadBindings());
        if (!target) return;
        const answer = ran.reply.trim().split("\n")[0] ?? "";
        await adapter.postIn(target, { text: `-# \`${ran.text.replace(/`/g, "'")}\` · you, on the dashboard${answer ? `\n-# ${answer.slice(0, 300)}` : ""}` });
      });
      // A chat deleted on the dashboard takes its thread with it.
      kernel.bus.on("chat:deleted", async ({ conversationId }) => {
        if (!adapter) return;
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
   * The schedule starts once every surface is wired, not before. A job that
   * fell due while KOS was down runs the moment it is caught up, and when
   * that happened ahead of Discord's login its "tell me" found no surface:
   * the job was marked failing, the caretaker opened a fix chat for it, and
   * the chat found nothing wrong, at a model turn's cost, on every restart.
   */
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
    server.close();
    void (async () => {
      try {
        if (runtime) await runtime.stop();
        if (smsRuntime) await smsRuntime.stop();
        if (imessageRuntime) await imessageRuntime.stop();
        imessageClaim?.release();
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

