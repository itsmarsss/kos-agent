import type { AuditEntry } from "@kos/harness";

import type { Build, BuildKind } from "./builds.js";
import { kindOf, type DeviceHub } from "./hub.js";
import type { DeviceStore, UpdateAttempt, UpdateOutcome } from "./store.js";

/**
 * Keeping each device app on the build KOS would hand it now, as
 * docs/computer.md (Builds and updates) says: each app tells KOS what it
 * runs when it connects, KOS compares that with what its checkout holds,
 * and one behind is updated or told so.
 *
 * KOS for Chrome reloads itself from its folder, once it is idle; KOS for
 * Mac is rebuilt and reinstalled on this computer, once its window is idle
 * and only when the owner's signing key keeps its permissions; KOS for
 * iPhone cannot update itself and says so. Each build is tried once per
 * device, an attempt kept across restarts; the owner's Update now tries
 * once more. Every attempt and outcome is in the audit log.
 */

export type UpdateState = "current" | "behind" | "updating" | "unknown";

/**
 * Why a device is where it is: KOS has no build of its own to hand it, the
 * app says no build (stamped before builds were), it runs on another
 * computer, it is waiting for an idle window, KOS for Mac's signing is not
 * set up, an iPhone needs Xcode, the owner turned updates off, or the last
 * try failed or left it behind.
 */
export type UpdateReason = "unbuilt" | "unstamped" | "remote" | "idle" | "signing" | "xcode" | "off" | "failed" | "stuck";

export interface UpdateStatus {
  state: UpdateState;
  /** What KOS would hand it now. */
  build?: Build;
  reason?: UpdateReason;
  /** The last line of a failed update. */
  detail?: string;
  /** KOS for Mac: what the owner runs by hand, to set signing up or to update it themselves. */
  command?: string;
}

/** What to do about one device now: nothing, tell a Chrome to reload, or reinstall KOS for Mac. */
export type UpdateAction = "none" | "reload" | "install";

export interface DecideInput {
  kind: BuildKind;
  /** The build the device runs, when it says. */
  running?: Build;
  /** The build KOS would hand it. */
  want?: Build;
  /** It runs on the computer KOS runs on. */
  local: boolean;
  /** The owner's "Update devices on their own". */
  auto: boolean;
  /** The owner asked for this update (Update now). */
  owner: boolean;
  /** How far updating it to `want` got before. */
  attempt?: UpdateAttempt;
  /** KOS for Mac: the owner's signing key is set up, so a rebuild keeps its permissions. */
  signed?: boolean;
  /** KOS for Mac: no session, ask or turn on it. */
  idle?: boolean;
}

export interface Decision {
  status: UpdateStatus;
  action: UpdateAction;
}

const IN_FLIGHT: ReadonlySet<UpdateOutcome> = new Set(["reloading", "installing", "installed"]);

/** What to do about one device, and how to say where it stands. Pure: every input is given. */
export function decide(i: DecideInput): Decision {
  const { want } = i;
  const none = (status: UpdateStatus): Decision => ({ status, action: "none" });
  if (!want) return none({ state: "unknown", reason: "unbuilt" });
  const behind = (reason: UpdateReason, detail?: string): Decision => none({ state: "behind", build: want, reason, ...(detail ? { detail } : {}) });
  // A KOS for Mac from before builds were stamped can still be rebuilt here, when the owner asks.
  const rebuildable = i.kind === "mac" && i.local && i.owner;
  if (!i.running && !rebuildable) return none({ state: "unknown", build: want, reason: "unstamped" });
  if (i.running?.id === want.id) return none({ state: "current", build: want });
  if (i.kind === "phone") return behind("xcode");
  if (!i.local) return behind("remote");
  const outcome = i.attempt?.outcome;
  if (outcome && IN_FLIGHT.has(outcome)) return none({ state: "updating", build: want });
  if (!i.owner) {
    if (outcome === "failed") return behind("failed", i.attempt?.detail);
    if (outcome === "still_behind") return behind("stuck");
    if (!i.auto) return behind("off");
    if (i.kind === "mac" && !i.signed) return behind("signing");
  }
  // Told again on each new line until it reloads: it waits for an idle side panel, and reloads once per build.
  if (i.kind === "chrome") return { status: { state: "behind", build: want, reason: "idle" }, action: "reload" };
  if (!i.idle) return behind("idle");
  return { status: { state: "updating", build: want }, action: "install" };
}

/** Rebuilding and reinstalling KOS for Mac on this computer, as scripts/bundle.sh --install does. */
export interface MacInstaller {
  /** Whether the owner's signing key is set up (scripts/signing.sh identity). */
  signed(): Promise<boolean>;
  /** Build and swap in the app; each line of its output is told as it comes. True when it finished. */
  install(line: (text: string) => void): Promise<boolean>;
  /** What the owner runs by hand: to set signing up, and to update it themselves. */
  commands: { signing: string; install: string };
}

export interface UpdatesDeps {
  hub: DeviceHub;
  store: DeviceStore;
  /** The build KOS would hand an app now, from what is on disk; undefined when it has none. */
  expected(kind: BuildKind): Build | undefined;
  /** Absent where KOS for Mac cannot be rebuilt (not a Mac checkout). */
  mac?: MacInstaller;
  /** No session, ask or turn on the device. */
  idle(device: string): boolean;
  audit?(entry: AuditEntry): void;
  log?(line: string): void;
}

/** The build kind of a paired device: a Chrome, a Mac running KOS for Mac, a phone; any other computer has none. */
export function buildKindOf(device: { platform: string }): BuildKind | undefined {
  const kind = kindOf(device);
  if (kind === "browser") return "chrome";
  if (kind === "phone") return "phone";
  return device.platform === "macos" ? "mac" : undefined;
}

/** How long a signing check is believed: it runs a command, and is asked on every idle change. */
const SIGNED_FOR_MS = 60_000;
/** As much of a failed build's output as is kept to say why. */
const TAIL_LINES = 20;

export class DeviceUpdates {
  /** Each device's status as last decided, and the frame it was last told, so a change is told once. */
  private readonly statuses = new Map<string, UpdateStatus>();
  private readonly told = new Map<string, string>();
  /** Devices whose owner pressed Update now, for the build they asked for: it waits for an idle window as any other. */
  private readonly asked = new Map<string, string>();
  /** KOS for Mac installs one at a time. */
  private installs: Promise<void> = Promise.resolve();
  private signedAt = 0;
  private signedWas = false;
  private readonly offs: (() => void)[] = [];

  constructor(private readonly deps: UpdatesDeps) {}

  /** Compare each device as it connects, hear Chromes say they reload, and look again whenever a device may have gone idle. */
  start(): void {
    const { hub } = this.deps;
    this.offs.push(
      hub.onConnected((device) => void this.connected(device)),
      hub.onDeviceEvent((device, event) => {
        if (event.name === "update.state") this.heard(device, event.data);
      }),
      hub.onChange(() => this.poke()),
    );
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
  }

  /** Where a device stands, as last decided; undefined while it is offline. */
  statusOf(device: string): UpdateStatus | undefined {
    return this.deps.hub.lineOf(device) ? this.statuses.get(device) : undefined;
  }

  /** The owner's Update now: the build is tried again, past the once-per-build guard and the signing rule. */
  async updateNow(device: string): Promise<UpdateStatus | undefined> {
    const found = this.deps.store.get(device);
    const kind = found && buildKindOf(found);
    const want = kind && this.deps.expected(kind);
    if (!want) return this.check(device);
    this.asked.set(device, want.id);
    const attempt = this.deps.store.attempt(device, want.id);
    if (attempt && !IN_FLIGHT.has(attempt.outcome)) this.deps.store.clearAttempt(device, want.id);
    return this.check(device);
  }

  /** Look again at every online device waiting on an idle window: a session or a turn may just have ended. */
  poke(): void {
    for (const [device, status] of this.statuses) if (status.reason === "idle" && this.deps.hub.lineOf(device)) void this.check(device);
  }

  /** A device just proved itself: what an update in flight came to, then where it stands now. */
  private async connected(device: string): Promise<void> {
    this.told.delete(device);
    const found = this.deps.store.get(device);
    const kind = found && buildKindOf(found);
    const want = kind && this.deps.expected(kind);
    const running = this.deps.hub.lineOf(device)?.build;
    const attempt = want && this.deps.store.attempt(device, want.id);
    if (kind && want && attempt) {
      if (running?.id === want.id && attempt.outcome !== "updated") this.settle(device, kind, attempt, "updated");
      // Reloaded or reinstalled, and still not the build: tried once, and left for the owner.
      else if (running?.id !== want.id && (attempt.outcome === "reloading" || attempt.outcome === "installed")) this.settle(device, kind, attempt, "still_behind");
    }
    await this.check(device);
  }

  /** Decide for one device and act: tell it where it stands, and reload or reinstall it when that is due. */
  async check(device: string): Promise<UpdateStatus | undefined> {
    const { hub, store } = this.deps;
    const found = store.get(device);
    const line = hub.lineOf(device);
    const kind = found && buildKindOf(found);
    if (!found || !line || !kind) return undefined;
    const want = this.deps.expected(kind);
    const owner = want !== undefined && this.asked.get(device) === want.id;
    const mac = kind === "mac";
    const input: DecideInput = {
      kind,
      local: line.local && (!mac || this.deps.mac !== undefined),
      auto: store.settings().autoUpdate,
      owner,
      ...(line.build ? { running: line.build } : {}),
      ...(want ? { want } : {}),
    };
    if (mac && input.local && want && line.build?.id !== want.id) {
      input.signed = await this.signed();
      input.idle = this.deps.idle(device);
    }
    // Read after the wait, and acted on before the next: two checks at once never both install.
    const attempt = want && store.attempt(device, want.id);
    if (attempt) input.attempt = attempt;
    const decision = decide(input);
    const { action } = decision;
    const status = this.withCommand(kind, decision.status);
    this.statuses.set(device, status);
    if (action === "reload" && want) {
      if (attempt?.outcome !== "told") store.setAttempt({ device, build: want.id, ...(line.build ? { from: line.build.id } : {}), outcome: "told" });
      this.tell(device, status, { action: "reload", ...(owner ? { force: true } : {}) });
      this.asked.delete(device);
    } else if (action === "install" && want) {
      this.asked.delete(device);
      store.setAttempt({ device, build: want.id, ...(line.build ? { from: line.build.id } : {}), outcome: "installing" });
      this.tell(device, status);
      this.audit(device, kind, line.build?.id, want.id, "installing", owner);
      this.installs = this.installs.then(() => this.install(device, kind, want));
    } else this.tell(device, status);
    return status;
  }

  /** A Chrome saying it reloads now into the build KOS told it of. */
  private heard(device: string, data: Record<string, unknown>): void {
    const found = this.deps.store.get(device);
    const want = found && buildKindOf(found) === "chrome" ? this.deps.expected("chrome") : undefined;
    if (!want || data.build !== want.id || data.state !== "reloading") return;
    const attempt = this.deps.store.attempt(device, want.id);
    if (attempt?.outcome !== "told") return;
    this.deps.store.setAttempt({ device, build: want.id, outcome: "reloading" });
    this.audit(device, "chrome", attempt.from, want.id, "reloading", false);
    this.statuses.set(device, { state: "updating", build: want });
  }

  /** Rebuild and reinstall KOS for Mac, its output in the host's log; what came of it is decided when it connects again. */
  private async install(device: string, kind: BuildKind, want: Build): Promise<void> {
    const tail: string[] = [];
    let ok = false;
    try {
      ok = await this.deps.mac!.install((text) => {
        this.deps.log?.(`devices: KOS for Mac update: ${text}`);
        tail.push(text);
        if (tail.length > TAIL_LINES) tail.shift();
      });
    } catch (err) {
      tail.push(err instanceof Error ? err.message : String(err));
    }
    // Settled already when the new app came back on its line before the script finished.
    const attempt = this.deps.store.attempt(device, want.id);
    if (attempt?.outcome !== "installing") return void (await this.check(device));
    if (!ok) this.settle(device, kind, attempt, "failed", tail.filter((l) => l.trim()).at(-1) ?? "the build stopped");
    else this.deps.store.setAttempt({ device, build: want.id, outcome: "installed" });
    await this.check(device);
  }

  private settle(device: string, kind: BuildKind, attempt: UpdateAttempt, outcome: UpdateOutcome, detail?: string): void {
    this.deps.store.setAttempt({ device, build: attempt.build, outcome, ...(detail ? { detail } : {}) });
    this.audit(device, kind, attempt.from, attempt.build, outcome, false, detail);
  }

  /** The device told where it stands, once per change; a Mac told how to set signing up or update by hand. */
  /** A KOS for Mac's status with the command the owner runs by hand: to set signing up, or to update it themselves after a try that did not take. */
  private withCommand(kind: BuildKind, status: UpdateStatus): UpdateStatus {
    const commands = this.deps.mac?.commands;
    if (kind !== "mac" || !commands) return status;
    const command = status.reason === "signing" ? commands.signing : status.reason === "failed" || status.reason === "stuck" ? commands.install : undefined;
    return command ? { ...status, command } : status;
  }

  private tell(device: string, status: UpdateStatus, extra: Record<string, unknown> = {}): void {
    const frame = { t: "update", ...status, ...extra };
    const text = JSON.stringify(frame);
    if (this.told.get(device) === text) return;
    this.told.set(device, text);
    this.deps.hub.tellDevice(device, frame);
  }

  private audit(device: string, kind: BuildKind, from: string | undefined, to: string, outcome: UpdateOutcome, owner: boolean, detail?: string): void {
    this.deps.audit?.({
      tool: "device.update",
      args: { device, kind, from: from ?? null, to, outcome, by: owner ? "owner" : "kos" },
      result: detail ? `${outcome}: ${detail}` : outcome,
      isError: outcome === "failed" || outcome === "still_behind",
    });
  }

  private async signed(): Promise<boolean> {
    if (Date.now() - this.signedAt < SIGNED_FOR_MS) return this.signedWas;
    this.signedWas = (await this.deps.mac?.signed().catch(() => false)) ?? false;
    this.signedAt = Date.now();
    return this.signedWas;
  }
}
