import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Which build of each device app is which, as docs/computer.md (Builds)
 * defines it: an id that is the content hash of what the app is made from,
 * the git commit of the checkout that built it, and when.
 *
 * The id alone decides whether a device is behind. A deploy that did not
 * touch an app's files keeps its id, whatever the commit says. Node only,
 * and nothing else of KOS's: the build scripts run it on its own (stamp.ts).
 */

export interface Build {
  /** The first 12 hex digits of the hash of the app's files. */
  id: string;
  /** The checkout's commit when it was built, 40 hex digits; empty outside a git checkout. */
  commit: string;
  /** When it was built, epoch ms. A build KOS would make, and has not, has none. */
  builtAt?: number;
}

/** The apps a build is of: KOS for Chrome, KOS for Mac and KOS for iPhone. */
export type BuildKind = "chrome" | "mac" | "phone";

/** The file each app carries its build in, beside its code. */
export const STAMP_FILE = "build.json";

/**
 * What each app is made from, relative to the checkout. KOS for Chrome is
 * the folder Chrome loads, so its own stamp is left out; the two native apps
 * are their sources, since a native build is not the same bytes twice.
 */
export const BUILD_SOURCES: Record<BuildKind, readonly string[]> = {
  chrome: ["packages/browser-extension/dist"],
  mac: [
    "packages/device-macos/Package.swift",
    "packages/device-macos/Sources",
    "packages/device-macos/Resources",
    "packages/device-macos/scripts/bundle.sh",
    "packages/device-macos/scripts/icon.swift",
    "packages/device-shared/Package.swift",
    "packages/device-shared/Sources",
  ],
  phone: ["packages/device-ios/Package.swift", "packages/device-ios/Sources", "packages/device-ios/App", "packages/device-shared/Package.swift", "packages/device-shared/Sources"],
};

const ID_RE = /^[0-9a-f]{12}$/;
const COMMIT_RE = /^([0-9a-f]{40})?$/;

/** Every file under a source, '/'-separated from the checkout; names starting with a dot and links are not the app's. */
function filesOf(root: string, path: string, out: string[]): void {
  let stat;
  try {
    stat = lstatSync(join(root, path));
  } catch {
    return;
  }
  if (stat.isFile()) out.push(path);
  else if (stat.isDirectory()) for (const name of readdirSync(join(root, path))) if (!name.startsWith(".")) filesOf(root, `${path}/${name}`, out);
}

/** The app's files, sorted as bytes, with KOS for Chrome's stamp left out. */
export function buildFiles(root: string, kind: BuildKind): string[] {
  const files: string[] = [];
  for (const source of BUILD_SOURCES[kind]) filesOf(root, source, files);
  const stamp = `${BUILD_SOURCES.chrome[0]}/${STAMP_FILE}`;
  return files.filter((f) => f !== stamp).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

/**
 * The id of what the checkout holds for an app: SHA-256 over one line per
 * file, `<path>\0<SHA-256 of its bytes, hex>\n`, its first 12 hex digits.
 * Undefined when the checkout holds none of it.
 */
export function buildId(root: string, kind: BuildKind): string | undefined {
  const files = buildFiles(root, kind);
  if (!files.length) return undefined;
  const all = createHash("sha256");
  for (const file of files) all.update(`${file}\0${createHash("sha256").update(readFileSync(join(root, file))).digest("hex")}\n`);
  return all.digest("hex").slice(0, 12);
}

/** The checkout's commit, or empty when it is not a git checkout. */
export function commitOf(root: string): string {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  const commit = head.status === 0 ? head.stdout.trim() : "";
  return COMMIT_RE.test(commit) ? commit : "";
}

/** The build the checkout would make of an app now: its id and commit, not yet built. */
export function sourceBuild(root: string, kind: BuildKind): Build | undefined {
  const id = buildId(root, kind);
  return id ? { id, commit: commitOf(root) } : undefined;
}

/** The stamp a build writes beside the app it built. */
export function stampOf(root: string, kind: BuildKind, now = Date.now()): Build | undefined {
  const build = sourceBuild(root, kind);
  return build ? { ...build, builtAt: now } : undefined;
}

/** A build as a device or a stamp says it, checked; anything else is no build. */
export function readBuild(v: unknown): Build | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const { id, commit, builtAt } = v as Record<string, unknown>;
  if (typeof id !== "string" || !ID_RE.test(id) || typeof commit !== "string" || !COMMIT_RE.test(commit)) return undefined;
  if (builtAt !== undefined && !(typeof builtAt === "number" && Number.isFinite(builtAt) && builtAt > 0)) return undefined;
  return { id, commit, ...(builtAt !== undefined ? { builtAt } : {}) };
}

/** The stamp in a file, or undefined when there is none that reads. */
export function readStamp(path: string): Build | undefined {
  try {
    return readBuild(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
}
