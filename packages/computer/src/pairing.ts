import { randomInt } from "node:crypto";

/**
 * One-time codes that let a device pair.
 *
 * The owner makes one on the dashboard, behind its token; the device brings
 * it back with its key. A code is good for ten minutes and one use. Forty
 * bits is far beyond guessing when ten wrong tries void every open code, so
 * a code can be short enough to read off a screen and type.
 */

/** No I, L, O, 0 or 1: nothing that reads as something else. */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const LENGTH = 8;
export const CODE_TTL_MS = 10 * 60 * 1000;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILURES = 10;
const MAX_OPEN = 5;

const normalize = (code: string): string => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

export interface PairingCode {
  code: string;
  expiresAt: number;
}

export class PairingCodes {
  /** Open codes, normalized, to when each expires; oldest first. */
  private readonly open = new Map<string, number>();
  private failures: number[] = [];

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

  /** Spend a code. True once for a live code; a wrong one counts toward voiding them all. */
  redeem(code: string): boolean {
    this.sweep();
    const key = normalize(code);
    if (this.open.has(key)) {
      this.open.delete(key);
      return true;
    }
    const now = this.now();
    this.failures = [...this.failures.filter((t) => now - t < FAILURE_WINDOW_MS), now];
    if (this.failures.length >= MAX_FAILURES) {
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
