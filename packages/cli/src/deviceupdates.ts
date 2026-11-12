import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { readStamp, sourceBuild, STAMP_FILE, type Build, type BuildKind, type ComputerUseOptions, type MacInstaller } from "@kos/computer";

/**
 * What the host hands each device app, from the checkout it runs from: KOS
 * for Chrome's built folder, and the sources KOS for Mac and KOS for iPhone
 * are built from, hashed once (a deploy restarts the host). KOS for Mac is
 * rebuilt here with its own scripts, on a Mac checkout alone.
 *
 * `KOS_DEVICE_MAC_SIGNING` and `KOS_DEVICE_MAC_INSTALL` name programs to
 * run instead of `signing.sh identity` and `bundle.sh --install`, so a
 * scratch host never signs, builds or installs anything for real.
 */

const quote = (path: string): string => (/^[\w./~-]+$/.test(path) ? path : `"${path.replace(/(["\\$`])/g, "\\$1")}"`);

export function deviceUpdates(root: string, log: (line: string) => void): NonNullable<ComputerUseOptions["updates"]> {
  const sources = new Map<BuildKind, Build | undefined>();
  const expected = (kind: BuildKind): Build | undefined => {
    // What Chrome would load on a reload: the folder as it is now.
    if (kind === "chrome") return readStamp(join(root, "packages", "browser-extension", "dist", STAMP_FILE));
    if (!sources.has(kind)) sources.set(kind, sourceBuild(root, kind));
    return sources.get(kind);
  };
  const app = join(root, "packages", "device-macos");
  const bundle = join(app, "scripts", "bundle.sh");
  const mac = process.platform === "darwin" && existsSync(bundle) ? macInstaller(app, log) : undefined;
  return { expected, ...(mac ? { mac } : {}), log };
}

function macInstaller(app: string, log: (line: string) => void): MacInstaller {
  const signing = process.env.KOS_DEVICE_MAC_SIGNING?.trim();
  const install = process.env.KOS_DEVICE_MAC_INSTALL?.trim();
  return {
    signed: () =>
      new Promise((resolve) => {
        const [file, args] = signing ? [signing, []] : [join(app, "scripts", "signing.sh"), ["identity"]];
        execFile(file, args, { cwd: app, timeout: 15_000 }, (err, stdout) => resolve(!err && stdout.trim().length > 0));
      }),
    install: (line) =>
      new Promise((resolve) => {
        const [file, args] = install ? [install, []] : [join(app, "scripts", "bundle.sh"), ["--install"]];
        log(`devices: rebuilding KOS for Mac with ${file} ${args.join(" ")}`.trim());
        // bundle.sh stamps the build with this Node, which launchd's PATH may not have.
        const child = spawn(file, args, { cwd: app, env: { ...process.env, KOS_NODE: process.execPath }, stdio: ["ignore", "pipe", "pipe"] });
        for (const stream of [child.stdout, child.stderr]) createInterface({ input: stream }).on("line", line);
        child.on("error", (err) => {
          line(err.message);
          resolve(false);
        });
        child.on("close", (code) => resolve(code === 0));
      }),
    commands: { signing: `cd ${quote(app)} && scripts/signing.sh setup`, install: `cd ${quote(app)} && scripts/bundle.sh --install` },
  };
}
