import { DiscordAdapter, Kernel, connectChannel } from "@kos/harness";

export interface DiscordOptions {
  rootDir: string;
  allowedHosts: string[];
}

/**
 * Run KOS on Discord: DMs become agent turns, replies go back as DMs, and risky
 * actions surface as native approve/deny buttons routed through the approval
 * queue. Needs KOS_SECRET_DISCORD (bot token) and KOS_OWNER_DISCORD (the owner's
 * Discord user id, for outbound notify and approval prompts).
 */
export async function runDiscord(options: DiscordOptions): Promise<void> {
  // Prefer the KOS-prefixed name; accept common aliases from a plain .env.
  const token =
    process.env.KOS_SECRET_DISCORD ??
    process.env.DISCORD_TOKEN ??
    process.env.DISCORD_BOT_TOKEN;
  const ownerId =
    process.env.KOS_OWNER_DISCORD ?? process.env.DISCORD_OWNER_ID;
  if (!token) {
    throw new Error(
      "Discord bot token not set (KOS_SECRET_DISCORD or DISCORD_TOKEN)",
    );
  }
  if (!ownerId) {
    throw new Error(
      "Discord owner id not set (KOS_OWNER_DISCORD or DISCORD_OWNER_ID)",
    );
  }

  const adapter = new DiscordAdapter({ token });

  const kernel = await Kernel.boot({
    rootDir: options.rootDir,
    allowedHosts: options.allowedHosts,
    notify: async (text) => adapter.send(ownerId, { text }),
    onApprovalRequested: (action) => {
      void adapter.requestApproval(ownerId, {
        id: String(action.id),
        text: `Approve ${action.tool}? ${action.args}`,
      });
    },
  });

  const runtime = connectChannel(adapter, kernel, { ownerRecipientId: ownerId });
  await runtime.start();
  kernel.startCron();

  console.log(`KOS on Discord. workspace: ${kernel.workspace.root}`);
  console.log("Listening for DMs. Ctrl-C to stop.");

  const shutdown = (): void => {
    void runtime.stop().then(() => {
      kernel.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
