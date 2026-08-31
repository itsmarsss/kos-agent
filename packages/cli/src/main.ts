#!/usr/bin/env node
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { Kernel, primarySessionId } from "@kos/harness";

import { KosClient, probeDaemon } from "./client.js";
import { OFFLINE_COMMANDS, parseArgs, runCommand, statusLine } from "./commands.js";
import { runDoctor } from "./doctor.js";
import { loadEnv } from "./env.js";
import { runHost, waitForPortFree } from "./host.js";
import { runRemoteCommand } from "./remote.js";
import {
  clearDaemonState,
  isPidAlive,
  readDaemonState,
  type DaemonState,
} from "./state.js";

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

function dashboardToken(): string | undefined {
  const t = process.env.KOS_DASHBOARD_TOKEN;
  return t && t.length > 0 ? t : undefined;
}

function listenHost(flag: string | boolean | undefined): string {
  if (typeof flag === "string") return flag;
  return process.env.KOS_HOST ?? "127.0.0.1";
}

function listenPort(flag: string | boolean | undefined): number {
  return Number(flag ?? process.env.KOS_PORT ?? 4317);
}

function baseUrlFromState(state: DaemonState): string {
  return `http://${state.host}:${state.port}`;
}

async function resolveLiveClient(
  rootDir: string,
): Promise<{ client: KosClient; state: DaemonState } | null> {
  const state = readDaemonState(rootDir);
  if (!state) return null;
  if (!isPidAlive(state.pid)) {
    clearDaemonState(rootDir);
    return null;
  }
  const token = dashboardToken();
  const baseUrl = baseUrlFromState(state);
  const up = await probeDaemon(baseUrl, token);
  if (!up) {
    clearDaemonState(rootDir);
    return null;
  }
  return {
    client: new KosClient({
      baseUrl,
      ...(token ? { token } : {}),
    }),
    state,
  };
}

async function remoteRepl(client: KosClient, workspace: string): Promise<void> {
  const sessionId = primarySessionId();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const s = await client.status();
  console.log(`KOS attached. workspace: ${workspace}`);
  console.log(
    [
      `host pid ${s.pid ?? "?"}`,
      `discord: ${s.discord ? "on" : "off"}`,
      `kill switch: ${s.halted ? "HALTED" : "running"}`,
      `pending: ${s.pendingApprovals}`,
    ].join(" | "),
  );
  console.log(`session: ${sessionId}`);
  console.log("Type a message, or /help. Ctrl-C to detach (host keeps running).\n");

  try {
    for (;;) {
      const line = (await rl.question("kos> ")).trim();
      if (line === "") continue;
      if (line === "/exit" || line === "/quit") break;

      if (line.startsWith("/")) {
        const { command, rest } = parseArgs(line.slice(1).split(/\s+/));
        if (command === "doctor") {
          console.log(await runDoctor({ workspace }));
          continue;
        }
        console.log(await runRemoteCommand(client, command, rest));
        continue;
      }

      try {
        const res = await client.message(line, { sessionId });
        console.log(res.reply || "(no reply)");
      } catch (err) {
        console.error(
          `error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } finally {
    rl.close();
  }
}

async function localRepl(kernel: Kernel): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`KOS ready (standalone). workspace: ${kernel.workspace.root}`);
  console.log(statusLine(kernel));
  console.log(
    "Tip: run `kos start` for Discord + shared session, then `kos` to attach.\n",
  );
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
        const res = await kernel.handleMessage(line, {
          sessionId: primarySessionId(kernel.profile.ownerId),
        });
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

async function cmdStart(
  rootDir: string,
  flags: Record<string, string | boolean>,
): Promise<void> {
  const host = listenHost(flags.host);
  const port = listenPort(flags.port);
  const existing = await resolveLiveClient(rootDir);
  if (existing) {
    console.log(
      `KOS already running (pid ${existing.state.pid}) on http://${existing.state.host}:${existing.state.port}`,
    );
    console.log("Attach with: kos");
    return;
  }

  const foreground =
    flags.foreground === true ||
    flags.fg === true ||
    process.env.KOS_FOREGROUND === "1";

  if (!foreground) {
    // Re-exec ourselves in the background as the host process.
    const self = fileURLToPath(import.meta.url);
    const args = [
      self,
      "start",
      "--foreground",
      "--workspace",
      rootDir,
      "--host",
      host,
      "--port",
      String(port),
    ];
    if (flags["no-discord"] === true) args.push("--no-discord");
    if (flags.discord === true) args.push("--discord");

    const logPath = join(rootDir, ".kos", "daemon.log");
    const { mkdirSync, openSync } = await import("node:fs");
    mkdirSync(dirname(logPath), { recursive: true });
    const logFd = openSync(logPath, "a");

    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
    });
    child.unref();

    // Wait until health responds.
    const token = dashboardToken();
    const baseUrl = `http://${host}:${port}`;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (await probeDaemon(baseUrl, token)) {
        console.log(`KOS started (pid ${child.pid}) on ${baseUrl}`);
        console.log(`log: ${logPath}`);
        console.log("Attach: kos   |  Discord: DM the bot if configured");
        return;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    console.error(
      `host did not become ready within 15s; check ${logPath}`,
    );
    process.exitCode = 1;
    return;
  }

  await runHost({
    rootDir,
    allowedHosts: allowedHosts(),
    host,
    port,
    ...(dashboardToken() ? { token: dashboardToken() } : {}),
    discord: flags["no-discord"] === true ? false : true,
    requireDiscord: flags.discord === true,
  });
}

async function cmdStop(rootDir: string): Promise<void> {
  const state = readDaemonState(rootDir);
  if (!state) {
    console.log("no kos host is running for this workspace");
    return;
  }
  if (!isPidAlive(state.pid)) {
    clearDaemonState(rootDir);
    console.log("stale pid cleared; host was not running");
    return;
  }
  try {
    process.kill(state.pid, "SIGTERM");
  } catch (err) {
    console.error(
      `failed to signal pid ${state.pid}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
    return;
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && isPidAlive(state.pid)) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (isPidAlive(state.pid)) {
    process.kill(state.pid, "SIGKILL");
  }
  clearDaemonState(rootDir);
  console.log(`stopped kos host (was pid ${state.pid})`);
}

/** Stop the running host, wait for its port, then start a fresh one. */
async function cmdRestart(
  rootDir: string,
  flags: Record<string, string | boolean>,
): Promise<void> {
  await cmdStop(rootDir);
  const host = listenHost(flags.host);
  const port = listenPort(flags.port);
  if (!(await waitForPortFree(host, port))) {
    console.error(
      `port ${port} is still in use; something other than this workspace's host may be holding it`,
    );
    process.exitCode = 1;
    return;
  }
  await cmdStart(rootDir, flags);
}

async function main(): Promise<void> {
  const { command, rest, flags } = parseArgs(process.argv.slice(2));
  const rootDir = workspaceDir(flags.workspace);

  if (command === "doctor") {
    console.log(await runDoctor({ workspace: rootDir }));
    return;
  }

  if (command === "start") {
    await cmdStart(rootDir, flags);
    return;
  }

  if (command === "stop") {
    await cmdStop(rootDir);
    return;
  }

  if (command === "restart") {
    await cmdRestart(rootDir, flags);
    return;
  }

  // discord / serve are aliases into the multi-modal host.
  if (command === "discord") {
    await cmdStart(rootDir, { ...flags, foreground: true, discord: true });
    return;
  }

  if (command === "serve") {
    // API-only style host still multi-modal capable; prefer start.
    await cmdStart(rootDir, {
      ...flags,
      foreground: true,
      "no-discord": flags.discord === true ? false : true,
    });
    return;
  }

  // Prefer attach when a host is already running.
  const live = await resolveLiveClient(rootDir);

  if (command === "chat" || command === undefined) {
    // parseArgs defaults command to "chat"
  }

  if (live) {
    if (command === "chat") {
      await remoteRepl(live.client, live.state.workspace);
      return;
    }
    if (command === "once") {
      if (rest.length === 0) {
        console.error('usage: kos once "your message"');
        process.exitCode = 1;
        return;
      }
      const res = await live.client.message(rest.join(" "), {
        sessionId: primarySessionId(),
      });
      console.log(res.reply || "(no reply)");
      return;
    }
    if (OFFLINE_COMMANDS.has(command) && command !== "doctor") {
      console.log(await runRemoteCommand(live.client, command, rest));
      return;
    }
    if (command === "help") {
      console.log(await runRemoteCommand(live.client, "help", []));
      return;
    }
  }

  // Standalone (no host): local kernel for chat/ops.
  if (command === "chat") {
    const kernel = await Kernel.boot({
      rootDir,
      allowedHosts: allowedHosts(),
    });
    await localRepl(kernel);
    return;
  }

  const kernel = await Kernel.boot({
    rootDir,
    allowedHosts: allowedHosts(),
  });
  try {
    if (command === "once") {
      if (rest.length === 0) {
        console.error('usage: kos once "your message"');
        process.exitCode = 1;
        return;
      }
      const res = await kernel.handleMessage(rest.join(" "), {
        sessionId: primarySessionId(kernel.profile.ownerId),
      });
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
