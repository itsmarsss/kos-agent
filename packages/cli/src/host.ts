import type { Server } from "node:http";
import { connect } from "node:net";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AllowlistMapping,
  ChannelRuntime,
  type ChannelAdapter,
  DiscordAdapter,
  IMessageAdapter,
  Kernel,
  connectChannel,
  conversationKind,
  createDashboardServer,
  createPressHandler,
  primarySessionId,
  surfaceSessionId,
  startSiteServer,
  type NotifyPayload,
} from "@kos/harness";

import { envFilePath } from "./env.js";
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

function discordCreds(): { token: string; ownerId: string } | null {
  const token =
    process.env.KOS_SECRET_DISCORD ??
    process.env.DISCORD_TOKEN ??
    process.env.DISCORD_BOT_TOKEN;
  const ownerId =
    process.env.KOS_OWNER_DISCORD ?? process.env.DISCORD_OWNER_ID;
  if (!token || !ownerId) return null;
  return { token, ownerId };
}

/**
 * The one iMessage conversation KOS may read, and where Messages keeps them.
 *
 * The handle is configuration and never a literal: it is the owner's own
 * phone number or Apple ID, and this repository is public. Absent it, the
 * surface stays off rather than guessing at a thread.
 */
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

  const notify =
    creds && wantDiscord
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
          // No surface named means wherever the owner already is, which is
          // the only one wired.
          const send = surfaces.get(wanted ?? "discord")?.();
          if (!send) {
            throw new Error(
              `the ${wanted ?? "discord"} surface is not connected. Connected: ${
                connected.join(", ") || "none"
              }.`,
            );
          }
          const msg = {
            text: payload.text,
            ...(payload.card ? { card: payload.card } : {}),
            ...(payload.buttons ? { buttons: payload.buttons } : {}),
          };
          // An addressed message goes through sendTo; the owner's DM is the
          // path everything took before and still takes.
          if (payload.target.kind === "owner") {
            await send.send(creds.ownerId, msg);
            return;
          }
          await send.sendTo?.(payload.target, msg);
        }
      : undefined;

  let adapter: DiscordAdapter | undefined;

  const kernel = await Kernel.boot({
    rootDir: options.rootDir,
    allowedHosts: options.allowedHosts,
    ...(notify ? { notify } : {}),
    ...(creds && wantDiscord
      ? {
          onApprovalRequested: (action) => {
            if (!adapter) return;
            void adapter.requestApproval(creds.ownerId, {
              id: String(action.id),
              text: `Approve ${action.tool}?`,
              tool: action.tool,
              args: action.args,
              reason: action.reason,
            });
          },
        }
      : {}),
  });

  kernel.startCron();
  // A job whose moment passed while nothing was running did not happen and
  // said nothing. At most one run each, however many were missed.
  const caught = kernel.catchUpCron();
  if (caught > 0) {
    console.log(`cron: ran ${caught} job${caught === 1 ? "" : "s"} that fell due while KOS was down`);
  }
  // Off unless the owner set an interval; the timer re-reads it, so turning
  // it on in settings does not need a restart.
  kernel.startHeartbeat();
  // Whatever the owner left running stays running across a restart of the
  // host, the same way a schedule does.
  kernel.startDaemons();

  const staticDir = process.env.KOS_UI_DIST ?? defaultUiDist();
  const meta = {
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
    adapter = new DiscordAdapter({ token: creds.token, ownerId: creds.ownerId });
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
  } else if (wantDiscord && !creds) {
    console.log(
      "Discord: skipped (set DISCORD_TOKEN + KOS_OWNER_DISCORD to enable)",
    );
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
      console.log(`iMessage: skipped (no database at ${imessage.dbPath})`);
    } else if (!claim.ok) {
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
        console.log("iMessage: watching your own thread");
      } catch (err) {
        // Full Disk Access not granted, a locked database, Messages not set
        // up: none of them are a reason for the host to refuse to start.
        imessageAdapter = undefined;
        imessageRuntime = undefined;
        imessageClaim?.release();
        imessageClaim = undefined;
        console.log(
          `iMessage: not started (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }
  }

  console.log("Attach with: kos   |  stop with: kos stop");

  const shutdown = (): void => {
    console.log("shutting down…");
    clearDaemonState(kernel.workspace.root);
    server.close();
    void (async () => {
      try {
        if (runtime) await runtime.stop();
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

