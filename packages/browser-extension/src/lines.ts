import type { LinkState } from "./link.js";
import type { Paired } from "./pairings.js";

/**
 * Each paired KOS's line, opened once: its key read, its link made and
 * dialled. A second ask while one is opening waits on it, so a worker that
 * wakes to its alarm and its start at once never dials twice. A line the
 * owner held, or unpaired, while its key was read is not opened. A line KOS
 * no longer takes is not dialled again by the minute's round, only when the
 * owner asks (Try now, Pair again, a changed setting).
 */

/** What a line needs of its link. */
export interface Dialled {
  start(): void;
}

export interface LinesDeps<L extends Dialled> {
  keysFor(device: string): Promise<CryptoKeyPair | undefined>;
  /** The link for a pairing, made but not dialled. */
  link(p: Paired, keys: CryptoKeyPair): L;
  /** Still paired, and not held by the owner. */
  wanted(device: string): boolean;
  stateOf(device: string): LinkState | undefined;
  setState(p: Paired, state: LinkState, detail?: string): void;
}

export class Lines<L extends Dialled> {
  readonly links = new Map<string, L>();
  private readonly opening = new Map<string, Promise<void>>();

  constructor(private readonly deps: LinesDeps<L>) {}

  /** Dial this KOS now: its link if it has one, else one opened. */
  connect(p: Paired): Promise<void> {
    const kept = this.links.get(p.device);
    if (kept) {
      kept.start();
      return Promise.resolve();
    }
    let pending = this.opening.get(p.device);
    if (!pending) {
      pending = this.open(p).finally(() => this.opening.delete(p.device));
      this.opening.set(p.device, pending);
    }
    return pending;
  }

  /** Every KOS the owner has not held; one KOS no longer takes only when `unpairedToo`. One that fails does not stop the rest. */
  async connectAll(pairings: readonly Paired[], unpairedToo = false): Promise<void> {
    for (const p of pairings) {
      if (!this.deps.wanted(p.device)) continue;
      if (!unpairedToo && this.deps.stateOf(p.device) === "unpaired") continue;
      await this.connect(p);
    }
  }

  private async open(p: Paired): Promise<void> {
    const id = p.device;
    let keys: CryptoKeyPair | undefined;
    try {
      keys = await this.deps.keysFor(id);
    } catch (err) {
      return this.deps.setState(p, "error", `This Chrome could not read its key: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Unpaired, held, or already opened, while its key was read.
    if (!this.deps.wanted(id) || this.links.has(id)) return;
    // Without its key this Chrome cannot prove it is the one that paired; only pairing again makes a new one.
    if (!keys) return this.deps.setState(p, "unpaired", "This Chrome no longer has the key it paired with. Pair again.");
    const link = this.deps.link(p, keys);
    this.links.set(id, link);
    link.start();
  }
}
