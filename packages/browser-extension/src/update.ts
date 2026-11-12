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
   * the owner asked), with no turn running and nothing else `busy` (a
   * session, or an ask for one).
   */
  due(busy: boolean, reloadedFor: string | undefined): { kos: string; build: string } | undefined {
    if (busy || [...this.turns.values()].some((chats) => chats.size > 0)) return undefined;
    for (const [kos, want] of this.wanted) if (want.force || want.build !== reloadedFor) return { kos, build: want.build };
    return undefined;
  }
}
