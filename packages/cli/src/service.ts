import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * The host as a launchd agent, so a host that dies comes back.
 *
 * `kos start` leaves a detached process behind and walks away. When that
 * process died at 9am from a socket error, nothing noticed until the
 * afternoon, and the cron jobs it owed ran in a bunch when someone finally
 * started it by hand. launchd restarts a process that exits badly and
 * starts it at login, which is the whole of what a supervisor has to do
 * for a personal agent. macOS only: this is where KOS runs, and iMessage
 * has already settled that.
 */

export const SERVICE_LABEL = "dev.kos.host";

export interface ServiceSpec {
  label: string;
  /** The node binary. launchd starts from a bare environment, so the path is spelled out. */
  node: string;
  /** The CLI's main.js. */
  main: string;
  /** Where the host runs from: the checkout, so its .env is found. */
  cwd: string;
  workspace: string;
  host: string;
  port: number;
  /** False passes --no-discord, for a second host that must not share the bot. */
  discord: boolean;
  /** Extra environment, on top of a PATH that can find node and npx. */
  env?: Record<string, string>;
}

export function plistPath(label: string): string {
  return join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

export function logPath(workspace: string): string {
  return join(workspace, ".kos", "daemon.log");
}

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The agent's plist.
 *
 * KeepAlive on an unsuccessful exit only: a crash is restarted, `kos stop`
 * (SIGTERM, exit 0) is honoured. RunAtLoad so it is up after a login.
 * ThrottleInterval so a host that cannot bind its port does not spin.
 */
export function launchdPlist(spec: ServiceSpec): string {
  const args = [
    spec.node,
    spec.main,
    "start",
    "--foreground",
    "--workspace",
    spec.workspace,
    "--host",
    spec.host,
    "--port",
    String(spec.port),
    ...(spec.discord ? [] : ["--no-discord"]),
  ];
  const path = [dirname(spec.node), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":");
  const env: Record<string, string> = { PATH: path, ...(spec.env ?? {}) };
  const log = logPath(spec.workspace);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key><string>${xml(spec.label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...args.map((a) => `    <string>${xml(a)}</string>`),
    "  </array>",
    `  <key>WorkingDirectory</key><string>${xml(spec.cwd)}</string>`,
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    ...Object.entries(env).map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`),
    "  </dict>",
    "  <key>RunAtLoad</key><true/>",
    "  <key>KeepAlive</key>",
    "  <dict><key>SuccessfulExit</key><false/></dict>",
    "  <key>ThrottleInterval</key><integer>10</integer>",
    `  <key>StandardOutPath</key><string>${xml(log)}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(log)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ];
  return lines.join("\n");
}

export interface ServiceState {
  /** The plist is on disk. */
  installed: boolean;
  /** launchd knows the label. */
  loaded: boolean;
  /** The host launchd is running right now, if any. */
  pid?: number;
  /** The workspace the installed agent serves, read from its plist. */
  workspace?: string;
}

/** The --workspace argument in an installed plist, so another workspace's start does not touch this agent. */
export function workspaceOfPlist(plist: string): string | undefined {
  const m = /<string>--workspace<\/string>\s*<string>([^<]*)<\/string>/.exec(plist);
  return m ? m[1]!.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">") : undefined;
}

function domain(): string {
  return `gui/${userInfo().uid}`;
}

async function launchctl(...args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout, stderr } = await exec("launchctl", args);
    return { ok: true, out: `${stdout}${stderr}` };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` || (e.message ?? String(err)) };
  }
}

/** What `launchctl print` says about the agent, read for the one fact wanted. */
export function parsePrint(out: string): { pid?: number } {
  const m = /^\s*pid = (\d+)/m.exec(out);
  return m ? { pid: Number(m[1]) } : {};
}

export async function serviceState(label: string): Promise<ServiceState> {
  const file = plistPath(label);
  const installed = existsSync(file);
  const workspace = installed ? workspaceOfPlist(readFileSync(file, "utf8")) : undefined;
  const base: ServiceState = { installed, loaded: false, ...(workspace ? { workspace } : {}) };
  if (process.platform !== "darwin") return base;
  const res = await launchctl("print", `${domain()}/${label}`);
  if (!res.ok) return base;
  return { ...base, loaded: true, ...parsePrint(res.out) };
}

function assertMac(): void {
  if (process.platform !== "darwin") {
    throw new Error("kos service needs launchd, which is macOS; elsewhere run `kos start --foreground` under your own supervisor");
  }
}

/** Write the plist and hand it to launchd, which starts the host at once. */
export async function installService(spec: ServiceSpec): Promise<string> {
  assertMac();
  const file = plistPath(spec.label);
  mkdirSync(dirname(file), { recursive: true });
  mkdirSync(dirname(logPath(spec.workspace)), { recursive: true });
  // A label launchd already holds has to be let go before a new plist
  // takes, or the old definition keeps running.
  if ((await serviceState(spec.label)).loaded) await launchctl("bootout", `${domain()}/${spec.label}`);
  writeFileSync(file, launchdPlist(spec), "utf8");
  const res = await launchctl("bootstrap", domain(), file);
  if (!res.ok) throw new Error(`launchctl bootstrap failed: ${res.out.trim()}`);
  return file;
}

/** Take it out of launchd and off the disk. The host it runs is stopped with it. */
export async function uninstallService(label: string): Promise<boolean> {
  assertMac();
  const file = plistPath(label);
  const state = await serviceState(label);
  if (state.loaded) await launchctl("bootout", `${domain()}/${label}`);
  if (state.installed) rmSync(file, { force: true });
  return state.installed || state.loaded;
}

/** Start the agent's host now, or restart it if it is running. */
export async function kickstart(label: string): Promise<void> {
  assertMac();
  const res = await launchctl("kickstart", "-k", `${domain()}/${label}`);
  if (!res.ok) throw new Error(`launchctl kickstart failed: ${res.out.trim()}`);
}
