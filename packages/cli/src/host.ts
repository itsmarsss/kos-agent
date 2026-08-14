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
} from "@kos/harness";

import { clearDaemonState, writeDaemonState } from "./state.js";

export interface HostOptions {
  rootDir: string;
  allowedHosts: string[];
  host: string;
  port: number;
  token?: string;
  /** Start Discord when token+owner are present (default true). */
  discord?: boolean;
  /** Require Discord credentials or fail. */
  requireDiscord?: boolean;
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
      ? async (text: string) => {
          // runtime's adapter is only available after start; capture adapter ref.
          if (adapter) await adapter.send(creds.ownerId, { text });
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

  const staticDir = process.env.KOS_UI_DIST ?? defaultUiDist();
  const meta = {
    pid: process.pid,
    discord: false,
    cron: true,
    workspace: kernel.workspace.root,
  };

  const server = createDashboardServer(kernel, {
    ...(staticDir ? { staticDir } : {}),
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

  console.log(`KOS host on http://${options.host}:${options.port}`);
  console.log(`workspace: ${kernel.workspace.root}`);
  console.log(`session: ${primarySessionId(kernel.profile.ownerId)}`);
  if (staticDir) console.log(`ui: ${staticDir}`);
  else console.log("ui: not built (pnpm -C packages/ui build); API only");

  if (wantDiscord && creds) {
    adapter = new DiscordAdapter({ token: creds.token });
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
