import type { Server } from "node:http";
import { connect } from "node:net";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AllowlistMapping,
  ChannelRuntime,
  DiscordAdapter,
  Kernel,
  connectChannel,
  createDashboardServer,
  primarySessionId,
  startSiteServer,
  type NotifyPayload,
} from "@kos/harness";

import { envFilePath } from "./env.js";
import { clearDaemonState, writeDaemonState } from "./state.js";

export interface HostOptions {
  rootDir: string;
  allowedHosts: string[] | (() => string[]);
  host: string;
  port: number;
  token?: string;
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
 * Multi-modal host: one Kernel, cron, local API/UI, optional Discord.
 * This is what `kos start` runs. CLI clients attach over the API.
 */
export async function runHost(options: HostOptions): Promise<void> {
  const wantDiscord = options.discord !== false;
  const creds = discordCreds();
  if (options.requireDiscord && !creds) {
    throw new Error(
      "Discord required but KOS_SECRET_DISCORD/DISCORD_TOKEN and KOS_OWNER_DISCORD/DISCORD_OWNER_ID are not set",
    );
  }

  let runtime: ChannelRuntime | undefined;

  const notify =
    creds && wantDiscord
      ? async (payload: NotifyPayload) => {
          // runtime's adapter is only available after start; capture adapter ref.
          if (!adapter) return;
          const msg = {
            text: payload.text,
            ...(payload.card ? { card: payload.card } : {}),
            ...(payload.buttons ? { buttons: payload.buttons } : {}),
          };
          // An addressed message goes through sendTo; the owner's DM is the
          // path everything took before and still takes.
          if (payload.target.kind === "owner") {
            await adapter.send(creds.ownerId, msg);
            return;
          }
          await adapter.sendTo(payload.target, msg);
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
    adapter.onButton(async (press) => {
      const route = kernel.presses.get(press.token);
      if (!route) {
        console.warn(`[discord] press on an unknown or expired button: ${press.token}`);
        return;
      }
      await kernel.handleMessage(`[pressed ${route.label}]`, {
        sessionId: route.conversationId,
        origin: "system",
      });
    });
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

  console.log("Attach with: kos   |  stop with: kos stop");

  const shutdown = (): void => {
    console.log("shutting down…");
    clearDaemonState(kernel.workspace.root);
    server.close();
    void (async () => {
      try {
        if (runtime) await runtime.stop();
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

