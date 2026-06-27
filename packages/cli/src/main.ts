#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import { Kernel } from "@kos/harness";

import { OFFLINE_COMMANDS, parseArgs, runCommand, statusLine } from "./commands.js";
import { runDiscord } from "./discord.js";

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
          "(a chat turn needs ANTHROPIC_API_KEY or OPENAI_API_KEY set)",
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

  if (command === "discord") {
    await runDiscord({ rootDir, allowedHosts: allowedHosts() });
    return; // long-running; shuts down on SIGINT
  }

  const kernel = await bootKernel(rootDir);

  if (command === "chat") {
    await repl(kernel);
    return;
  }

  try {
    if (command === "once") {
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
