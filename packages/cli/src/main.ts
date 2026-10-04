#!/usr/bin/env node
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { Kernel, SecretsRegistry, createDefaultRouter, primarySessionId, renderEvalReport, runMemoryEval } from "@kos/harness";

import { KosClient, probeDaemon } from "@kos/client";
import { OFFLINE_COMMANDS, parseArgs, runCommand, statusLine } from "./commands.js";
import { runDoctor } from "./doctor.js";
import { envFilePath, loadEnv } from "./env.js";
import {
  SERVICE_LABEL,
  installService,
  kickstart,
  serviceState,
  uninstallService,
} from "./service.js";
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

/**
 * Not under KOS_SECRET_: that prefix hands a value to the agent as a
 * secret it can use, and the thing that lets the outside start a job is
 * not something the agent should hold.
 */
function hookSecret(): string | undefined {
  const s = process.env.KOS_HOOK_SECRET?.trim();
  return s ? s : undefined;
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

/**
 * Port for serving what the agent built, defaulting to next to the dashboard.
 * A separate port is not a convenience: it puts a site on its own origin,
 * where its scripts cannot reach the dashboard's API. 0 turns serving off.
 */
function sitesPort(
  flag: string | boolean | undefined,
  dashboard: number,
): number {
  const raw = flag ?? process.env.KOS_SITES_PORT;
  return raw === undefined ? dashboard + 1 : Number(raw);
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
    const service = await serviceState(SERVICE_LABEL);
    // Only the workspace the agent was installed for: a scratch host on
    // another port must not kick the owner's real one.
    if (service.loaded && service.workspace === rootDir) {
      // launchd owns the host: a detached one beside it would fight for
      // the port and lose, and launchd would restart its own anyway.
      await kickstart(SERVICE_LABEL);
      const baseUrl = `http://${host}:${port}`;
      if (await waitForDaemon(baseUrl, dashboardToken())) {
        console.log(`KOS started under launchd on ${baseUrl}`);
      } else {
        console.error(`launchd started the host but it did not answer within 15s; check ${join(rootDir, ".kos", "daemon.log")}`);
        process.exitCode = 1;
      }
      return;
    }
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

    const baseUrl = `http://${host}:${port}`;
    if (await waitForDaemon(baseUrl, dashboardToken())) {
      console.log(`KOS started (pid ${child.pid}) on ${baseUrl}`);
      console.log(`log: ${logPath}`);
      console.log("Attach: kos   |  Discord: DM the bot if configured");
      return;
    }
    console.error(
      `host did not become ready within 15s; check ${logPath}`,
    );
    process.exitCode = 1;
    return;
  }

  await runHost({
    rootDir,
    allowedHosts,
    host,
    port,
    ...(dashboardToken() ? { token: dashboardToken() } : {}),
    ...(hookSecret() ? { hookSecret: hookSecret() } : {}),
    discord: flags["no-discord"] === true ? false : true,
    requireDiscord: flags.discord === true,
    sitesPort: sitesPort(flags["sites-port"], port),
  });
}

/** Poll health until it answers, or give up after 15s. */
async function waitForDaemon(baseUrl: string, token: string | undefined): Promise<boolean> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await probeDaemon(baseUrl, token)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/**
 * kos service install | uninstall | status
 *
 * Install stops a host started by hand first: launchd starts its own at
 * once, and two on one port is one host and a restart loop.
 */
async function cmdService(
  rootDir: string,
  sub: string | undefined,
  flags: Record<string, string | boolean>,
): Promise<void> {
  if (sub === "install") {
    const state = readDaemonState(rootDir);
    if (state && isPidAlive(state.pid)) await cmdStop(rootDir);
    const file = await installService({
      label: SERVICE_LABEL,
      node: process.execPath,
      main: fileURLToPath(import.meta.url),
      cwd: dirname(envFilePath()),
      workspace: rootDir,
      host: listenHost(flags.host),
      port: listenPort(flags.port),
      discord: flags["no-discord"] !== true,
    });
    console.log(`installed ${file}`);
    const baseUrl = `http://${listenHost(flags.host)}:${listenPort(flags.port)}`;
    if (await waitForDaemon(baseUrl, dashboardToken())) {
      console.log(`KOS running under launchd on ${baseUrl}; it restarts after a crash and starts at login`);
      if (process.env.KOS_OWNER_IMESSAGE?.trim()) {
        // A terminal passes its own Full Disk Access down; launchd passes nothing.
        console.log(`iMessage under launchd needs Full Disk Access for ${process.execPath}: System Settings > Privacy & Security > Full Disk Access, then kos restart`);
      }
    } else {
      console.error(`launchd has it, but the host did not answer within 15s; check ${join(rootDir, ".kos", "daemon.log")}`);
      process.exitCode = 1;
    }
    return;
  }
  if (sub === "uninstall") {
    const was = await uninstallService(SERVICE_LABEL);
    console.log(was ? "removed the launchd agent; the host it ran is stopped" : "no launchd agent was installed");
    return;
  }
  if (sub === "status" || sub === undefined) {
    const s = await serviceState(SERVICE_LABEL);
    if (!s.installed && !s.loaded) console.log("not installed; kos service install makes the host a launchd agent");
    else if (!s.loaded) console.log("plist on disk but launchd does not have it; kos service install again");
    else if (s.pid) console.log(`running under launchd (pid ${s.pid})`);
    else console.log("loaded in launchd but not running; kos start brings it up");
    return;
  }
  console.error("usage: kos service install | uninstall | status");
  process.exitCode = 1;
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

  // kos eval memory: run the extractor over the golden set with the real
  // cheap model and print the numbers. Spends a little; prints what it did.
  if (command === "eval") {
    if (rest[0] !== "memory") {
      console.error("usage: kos eval memory [--json]");
      process.exitCode = 1;
      return;
    }
    const report = await runMemoryEval(createDefaultRouter(SecretsRegistry.fromEnv()));
    console.log(flags.json === true ? JSON.stringify(report, null, 2) : renderEvalReport(report));
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

  if (command === "service") {
    await cmdService(rootDir, rest[0], flags);
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
      allowedHosts,
    });
    await localRepl(kernel);
    return;
  }

  const kernel = await Kernel.boot({
    rootDir,
    allowedHosts,
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
