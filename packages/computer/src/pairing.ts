import { randomInt } from "node:crypto";

/**
 * One-time codes that let a device pair.
 *
 * The owner makes one on the dashboard, behind its token; the device brings
 * it back with its key. A code is good for ten minutes and one use. Forty
 * bits is far beyond guessing when one source's ten wrong tries shut it out
 * for ten minutes, and wrong tries from several sources void every open
 * code; so a code can be short enough to read off a screen and type, and
 * one web page or host guessing cannot void the owner's.
 */

/** No I, L, O, 0 or 1: nothing that reads as something else. */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const LENGTH = 8;
export const CODE_TTL_MS = 10 * 60 * 1000;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILURES = 10;
/** Wrong tries void every open code only when they come from at least this many sources. */
const VOID_SOURCES = 3;
const MAX_OPEN = 5;

const normalize = (code: string): string => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

export interface PairingCode {
  code: string;
  expiresAt: number;
}

export class PairingCodes {
  /** Open codes, normalized, to when each expires; oldest first. */
  private readonly open = new Map<string, number>();
  /** Wrong tries in the window: when, and from where. */
  private failures: { at: number; source: string }[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  issue(): PairingCode {
    this.sweep();
    while (this.open.size >= MAX_OPEN) this.open.delete(this.open.keys().next().value!);
    let raw = "";
    for (let i = 0; i < LENGTH; i++) raw += ALPHABET[randomInt(ALPHABET.length)];
    const expiresAt = this.now() + CODE_TTL_MS;
    this.open.set(raw, expiresAt);
    return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt };
  }

  /** Whether a code is open now, without spending it. */
  has(code: string): boolean {
    this.sweep();
    return this.open.has(normalize(code));
  }

  /**
   * Spend a code. True once for a live code. A wrong one counts against its
   * source (an address, or a page's origin), which is shut out after its
   * share; wrong ones from several sources void every open code.
   */
  redeem(code: string, source = ""): boolean {
    this.sweep();
    const now = this.now();
    this.failures = this.failures.filter((f) => now - f.at < FAILURE_WINDOW_MS);
    if (this.failures.filter((f) => f.source === source).length >= MAX_FAILURES) return false;
    const key = normalize(code);
    if (this.open.has(key)) {
      this.open.delete(key);
      return true;
    }
    this.failures.push({ at: now, source });
    if (this.failures.length >= MAX_FAILURES && new Set(this.failures.map((f) => f.source)).size >= VOID_SOURCES) {
      this.open.clear();
      this.failures = [];
    }
    return false;
  }

  private sweep(): void {
    const now = this.now();
    for (const [code, expiresAt] of this.open) if (expiresAt <= now) this.open.delete(code);
  }
}
