#!/usr/bin/env node
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { Kernel, createDashboardServer } from "@kos/harness";

import { OFFLINE_COMMANDS, parseArgs, runCommand, statusLine } from "./commands.js";
import { runDiscord } from "./discord.js";
import { runDoctor } from "./doctor.js";
import { loadEnv } from "./env.js";

loadEnv();

function workspaceDir(flag: string | boolean | undefined): string {
  if (typeof flag === "string") return flag;
  return process.env.KOS_WORKSPACE ?? join(homedir(), "kos-workspace");
}

function allowedHosts(): string[] {
  return (process.env.KOS_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
}

function defaultUiDist(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  // packages/cli/dist -> packages/ui/dist
  const candidate = resolve(here, "../../ui/dist");
  return existsSync(join(candidate, "index.html")) ? candidate : undefined;
}

async function bootKernel(rootDir: string): Promise<Kernel> {
  return Kernel.boot({ rootDir, allowedHosts: allowedHosts() });
}

async function repl(kernel: Kernel): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`KOS ready. workspace: ${kernel.workspace.root}`);
  console.log(statusLine(kernel));
  console.log("Type a message, or /help for commands. Ctrl-C to exit.\n");
  kernel.startCron();

  try {
    for (;;) {
      const line = (await rl.question("kos> ")).trim();
      if (line === "") continue;
      if (line === "/exit" || line === "/quit") break;

      if (line.startsWith("/")) {
        const { command, rest } = parseArgs(line.slice(1).split(/\s+/));
        if (command === "doctor") {
          console.log(await runDoctor({ workspace: kernel.workspace.root }));
          continue;
        }
        console.log(await runCommand(kernel, command, rest));
        continue;
      }

      try {
        const res = await kernel.handleMessage(line);
        console.log(res.reply || "(no reply)");
      } catch (err) {
        console.error(
          `error: ${err instanceof Error ? err.message : String(err)}`,
        );
        console.error(
          "(a chat turn needs ANTHROPIC_API_KEY or OPENAI_API_KEY in .env)",
        );
      }
    }
  } finally {
    rl.close();
    kernel.close();
  }
}

async function main(): Promise<void> {
  const { command, rest, flags } = parseArgs(process.argv.slice(2));
  const rootDir = workspaceDir(flags.workspace);

  if (command === "doctor") {
    console.log(await runDoctor({ workspace: rootDir }));
    return;
  }

  if (command === "discord") {
    await runDiscord({ rootDir, allowedHosts: allowedHosts() });
    return; // long-running; shuts down on SIGINT
  }

  if (command === "serve") {
    const kernel = await bootKernel(rootDir);
    kernel.startCron();
    const port = Number(flags.port ?? process.env.KOS_PORT ?? 4317);
    const host =
      typeof flags.host === "string"
        ? flags.host
        : (process.env.KOS_HOST ?? "127.0.0.1");
    const token =
      typeof process.env.KOS_DASHBOARD_TOKEN === "string" &&
      process.env.KOS_DASHBOARD_TOKEN.length > 0
        ? process.env.KOS_DASHBOARD_TOKEN
        : undefined;
    const staticDir =
      typeof flags.ui === "string"
        ? flags.ui
        : (process.env.KOS_UI_DIST ?? defaultUiDist());

    const server = createDashboardServer(kernel, {
      ...(staticDir ? { staticDir } : {}),
      ...(token ? { token } : {}),
      host,
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(
          `port ${port} is already in use (another 'kos serve'?). ` +
            `Free it or pick another: kos serve --port 4500`,
        );
      } else {
        console.error(`server error: ${err.message}`);
      }
      kernel.close();
      process.exit(1);
    });

    server.listen(port, host, () => {
      console.log(`KOS dashboard on http://${host}:${port}`);
      console.log(`workspace: ${kernel.workspace.root}`);
      if (staticDir) console.log(`ui: ${staticDir}`);
      else console.log("ui: not built (pnpm -C packages/ui build); API only");
      if (token) console.log("auth: KOS_DASHBOARD_TOKEN required for POST");
      if (host !== "127.0.0.1" && host !== "localhost" && !token) {
        console.warn(
          "warning: bound beyond loopback without KOS_DASHBOARD_TOKEN",
        );
      }
    });
    const shutdown = (): void => {
      server.close();
      kernel.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return; // long-running
  }

  const kernel = await bootKernel(rootDir);

  if (command === "chat") {
    await repl(kernel);
    return;
  }

  try {
    if (command === "once") {
      if (rest.length === 0) {
        console.error('usage: kos once "your message"');
        process.exitCode = 1;
        return;
      }
      const res = await kernel.handleMessage(rest.join(" "));
      console.log(res.reply || "(no reply)");
    } else if (OFFLINE_COMMANDS.has(command)) {
      console.log(await runCommand(kernel, command, rest));
    } else {
      console.log(await runCommand(kernel, command, rest));
    }
  } finally {
    kernel.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
