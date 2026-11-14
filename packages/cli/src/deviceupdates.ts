import { execFile, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { readStamp, sourceBuild, STAMP_FILE, type Build, type BuildKind, type ComputerUseOptions, type MacInstaller } from "@kos/computer";

/**
 * What the host hands each device app, from the checkout it runs from: KOS
 * for Chrome's built folder, and the sources KOS for Mac and KOS for iPhone
 * are built from, hashed at start and again whenever asked fresh (before an
 * install, and when a Mac comes back on another build). KOS for Mac is
 * rebuilt here with its own scripts, on a Mac checkout alone.
 *
 * `KOS_DEVICE_MAC_SIGNING` and `KOS_DEVICE_MAC_INSTALL` name programs to
 * run instead of `signing.sh identity` and `bundle.sh --install`, so a
 * scratch host never signs, builds or installs anything for real.
 */

/** The longest a rebuild may take: past it, a hung swift build or a prompt nobody can answer is stopped. */
export const INSTALL_TIMEOUT_MS = 15 * 60_000;
/** How long a stopped build has to end on TERM before its whole group is killed. */
export const KILL_GRACE_MS = 10_000;
/** What a build and its signing need of the host's environment, and no more: the host's own secrets stay with it. */
const CHILD_ENV = ["HOME", "PATH", "TMPDIR", "DEVELOPER_DIR", "LANG", "USER", "LOGNAME", "KOS_DEVICE_SIGNING_KEYCHAIN"];

const quote = (path: string): string => (/^[\w./~-]+$/.test(path) ? path : `"${path.replace(/(["\\$`])/g, "\\$1")}"`);

/** The environment a build runs in: the few names it needs from the host's, and the Node to stamp with. */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { KOS_NODE: process.execPath };
  for (const name of CHILD_ENV) if (env[name] !== undefined) out[name] = env[name];
  return out;
}

export function deviceUpdates(root: string, log: (line: string) => void): NonNullable<ComputerUseOptions["updates"]> {
  const sources = new Map<BuildKind, Build | undefined>();
  const stamp = join(root, "packages", "browser-extension", "dist", STAMP_FILE);
  let chrome: { mtime: number; build: Build | undefined } | undefined;
  const expected = (kind: BuildKind, fresh = false): Build | undefined => {
    // What Chrome would load on a reload: the folder's stamp as it is now, read again only when it changed.
    if (kind === "chrome") {
      const mtime = existsSync(stamp) ? statSync(stamp).mtimeMs : 0;
      if (chrome?.mtime !== mtime) chrome = { mtime, build: mtime ? readStamp(stamp) : undefined };
      return chrome.build;
    }
    if (fresh || !sources.has(kind)) sources.set(kind, sourceBuild(root, kind));
    return sources.get(kind);
  };
  const app = join(root, "packages", "device-macos");
  const mac = process.platform === "darwin" && existsSync(join(app, "scripts", "bundle.sh")) ? macInstaller(app, log) : undefined;
  return { expected, ...(mac ? { mac } : {}), log };
}

export interface InstallerOptions {
  /** Programs to run instead of the scripts, for a scratch host. */
  signing?: string;
  install?: string;
  timeoutMs?: number;
  graceMs?: number;
}

export function macInstaller(app: string, log: (line: string) => void, options: InstallerOptions = {}): MacInstaller {
  const signing = options.signing ?? process.env.KOS_DEVICE_MAC_SIGNING?.trim();
  const install = options.install ?? process.env.KOS_DEVICE_MAC_INSTALL?.trim();
  const timeoutMs = options.timeoutMs ?? INSTALL_TIMEOUT_MS;
  const graceMs = options.graceMs ?? KILL_GRACE_MS;
  const commands = { signing: `cd ${quote(app)} && scripts/signing.sh setup`, install: `cd ${quote(app)} && scripts/bundle.sh --install` };
  return {
    signed: () =>
      new Promise((resolve) => {
        const [file, args] = signing ? [signing, []] : [join(app, "scripts", "signing.sh"), ["identity"]];
        execFile(file, args, { cwd: app, timeout: 15_000, env: childEnv() }, (err, stdout) => resolve(!err && stdout.trim().length > 0));
      }),
    install: (line) =>
      new Promise((resolve) => {
        const [file, args] = install ? [install, []] : [join(app, "scripts", "bundle.sh"), ["--install"]];
        log(`devices: rebuilding KOS for Mac with ${file} ${args.join(" ")}`.trim());
        // A group of its own: a host stopping does not take the swap down half done, and a timeout ends all of it.
        const child = spawn(file, args, { cwd: app, env: childEnv(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
        let last = "";
        let locked = false;
        const heard = (text: string): void => {
          if (text.trim()) last = text.trim();
          if (/errSecInternalComponent/.test(text)) locked = true;
          line(text);
        };
        for (const stream of [child.stdout, child.stderr]) createInterface({ input: stream }).on("line", heard);
        let settled = false;
        const finish = (result: { ok: true } | { ok: false; why: string }): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };
        const signal = (name: NodeJS.Signals): void => {
          try {
            if (child.pid) process.kill(-child.pid, name);
          } catch {
            // Gone already.
          }
        };
        // Past its time: TERM to the whole group, then KILL to whatever ignored it. Said from here, whether or not it ends.
        const timer = setTimeout(() => {
          signal("SIGTERM");
          setTimeout(() => signal("SIGKILL"), graceMs).unref();
          finish({ ok: false, why: `the build took longer than ${Math.round(timeoutMs / 60_000)} minutes and was stopped` });
        }, timeoutMs);
        const done = (code: number | null, error?: Error): void => {
          if (code === 0) return finish({ ok: true });
          // codesign asks for the signing key's PIN, which only the owner's own Terminal can show.
          if (locked) return finish({ ok: false, why: "the signing key is locked, and macOS asks for its PIN only in your own Terminal" });
          finish({ ok: false, why: error?.message ?? (last || `the build stopped (exit ${code ?? "by a signal"})`) });
        };
        child.on("error", (err) => done(null, err));
        child.on("close", (code) => done(code));
      }),
    commands,
  };
}
