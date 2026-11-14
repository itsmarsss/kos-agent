/**
 * KOS for Chrome keeping to the build KOS would hand it (docs/computer.md,
 * Builds and updates). The extension says its build in each hello; a KOS
 * on this computer that has a newer one in its folder tells it so, and it
 * reloads itself from that folder: only once no side panel turn runs and no
 * session is held or asked for, only once per build unless the owner
 * pressed Update now, and only as an unpacked extension, which is the one
 * a reload brings new code to.
 */

export interface Build {
  id: string;
  commit: string;
  builtAt?: number;
}

/** What KOS says of this Chrome's build: where it stands, and to reload when it is behind and KOS can hand it a new one. */
export interface UpdateNotice {
  state: "current" | "behind" | "updating" | "unknown";
  build?: Build;
  reload: boolean;
  /** The owner pressed Update now: tried again though this build was reloaded for before. */
  force: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A build as a stamp or KOS says it; anything else is none. */
export function readBuild(v: unknown): Build | undefined {
  if (!isRecord(v) || typeof v["id"] !== "string" || !/^[0-9a-f]{12}$/.test(v["id"]) || typeof v["commit"] !== "string") return undefined;
  const builtAt = v["builtAt"];
  return { id: v["id"], commit: v["commit"], ...(typeof builtAt === "number" ? { builtAt } : {}) };
}

/** What the extension keeps a value in: chrome.storage's session or local area, or a test's stand-in. */
export interface Kept {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

const LOADED = "buildRead";
const BUILD = "build";

/**
 * The build of the code running now. Read from its folder once each time
 * Chrome loads the code (an install, a reload, an update, Chrome starting:
 * each empties session storage), and kept: a worker that wakes later reads
 * the kept one, since by then a deploy may have rebuilt the folder under it.
 */
export async function runningBuild(session: Kept, local: Kept, read: () => Promise<Build | undefined>): Promise<Build | undefined> {
  if ((await session.get(LOADED)) === true) return readBuild(await local.get(BUILD));
  const build = await read();
  await local.set(BUILD, build ?? null);
  await session.set(LOADED, true);
  return build;
}

/**
 * Whether the folder holds the whole of the build KOS named, so a reload
 * now loads it: the manifest reads and the stamp is that build. A folder
 * being rebuilt (the build starts by removing it) is neither.
 */
export async function folderHolds(build: string, fetchText: (file: string) => Promise<string | undefined>): Promise<boolean> {
  try {
    const manifest = await fetchText("manifest.json");
    const stamp = await fetchText("build.json");
    if (!manifest || !stamp) return false;
    JSON.parse(manifest);
    return readBuild(JSON.parse(stamp))?.id === build;
  } catch {
    return false;
  }
}

/** How long a folder may go without the build KOS named before the extension says so and stops waiting. */
export const FOLDER_GIVE_UP_MS = 3 * 60_000;

/**
 * The wait for the folder to hold a build: looked at again while a rebuild
 * may still be finishing, then given up, once, so KOS hears the folder lacks
 * it (a Chrome loaded from another folder than KOS's) rather than waiting
 * forever.
 */
export class FolderWait {
  private build: string | undefined;
  private since = 0;
  private done = false;

  /** The folder lacked `build` again: look `again`, `give-up` now (said once), or nothing more to do (`done`). */
  miss(build: string, now = Date.now()): "again" | "give-up" | "done" {
    if (build !== this.build) {
      this.build = build;
      this.since = now;
      this.done = false;
    }
    if (this.done) return "done";
    if (now - this.since < FOLDER_GIVE_UP_MS) return "again";
    this.done = true;
    return "give-up";
  }
}

/** The build the extension last reloaded itself into, and when. */
export interface Reloaded {
  build: string;
  at: number;
}

/** How long a forced reload into the same build is refused again: a lost word from KOS does not reload it on every line. */
export const FORCED_AGAIN_MS = 10 * 60_000;

/** An update frame from KOS, read; one that does not read is none. */
export function readUpdate(raw: Record<string, unknown>): UpdateNotice | undefined {
  const state = raw["state"];
  if (state !== "current" && state !== "behind" && state !== "updating" && state !== "unknown") return undefined;
  const build = readBuild(raw["build"]);
  return { state, ...(build ? { build } : {}), reload: raw["action"] === "reload" && build !== undefined, force: raw["force"] === true };
}

/**
 * Whether the extension may reload now, from what it hears: KOS's word of
 * a newer build, and the side panel's chats, whose turns start when KOS
 * takes the owner's words or tells a story and end when the story is done,
 * a turn fails or the chat is shown answered.
 */
export class ReloadGate {
  /** The newer build each KOS told of, and whether the owner asked for it. */
  private readonly wanted = new Map<string, { build: string; force: boolean }>();
  /** The chats with a turn on the go, by KOS. */
  private readonly turns = new Map<string, Set<string>>();

  /** KOS's word on this Chrome's build. */
  told(kos: string, notice: UpdateNotice): void {
    if (notice.reload && notice.build) this.wanted.set(kos, { build: notice.build.id, force: notice.force });
    else this.wanted.delete(kos);
  }

  /** A chat call from KOS, on its way to the side panel. */
  heard(kos: string, method: string, params: Record<string, unknown>): void {
    const chat = typeof params["conversation"] === "string" ? params["conversation"] : typeof params["chat"] === "string" ? params["chat"] : undefined;
    if (!chat) return;
    const running = this.turns.get(kos) ?? new Set<string>();
    this.turns.set(kos, running);
    if (method === "chat.status") {
      if (params["story"] === null || "error" in params) running.delete(chat);
      else if ((params["taken"] === true && params["command"] !== true) || typeof params["story"] === "string") running.add(chat);
    } else if (method === "chat.show") {
      const lines = Array.isArray(params["messages"]) ? (params["messages"] as { role?: unknown }[]) : [];
      if (lines.at(-1)?.role !== "you") running.delete(chat);
    }
  }

  /** A KOS's line went: its turns are not known to run any more, and it is told again when it is back. */
  gone(kos: string): void {
    this.turns.delete(kos);
    this.wanted.delete(kos);
  }

  /**
   * The build to reload into now: told of, not reloaded for already (unless
   * the owner asked, and not in the last ten minutes even then), with no
   * turn running and nothing else `busy` (a session, or an ask for one).
   */
  due(busy: boolean, reloaded: Reloaded | undefined, now = Date.now()): { kos: string; build: string } | undefined {
    if (busy || [...this.turns.values()].some((chats) => chats.size > 0)) return undefined;
    for (const [kos, want] of this.wanted) {
      const again = want.build === reloaded?.build;
      if (!again || (want.force && now - reloaded.at >= FORCED_AGAIN_MS)) return { kos, build: want.build };
    }
    return undefined;
  }
}
