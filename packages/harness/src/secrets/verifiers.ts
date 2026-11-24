import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { readPrivate, writeAtomic } from "./vaultfs.js";

/**
 * Secrets KOS only ever checks, kept as verifiers (docs/secrets.md,
 * Verifiers): HMAC-SHA256 of the value under a pepper of this host's, never
 * the value. A copy of the file opens nothing and names nothing; with the
 * pepper it can still be guessed at, which is why both live in `~/.kos`,
 * outside the workspace and denied to every jailed program.
 *
 * The hook secret is one: a webhook sender holds it, KOS compares. The
 * dashboard token is not: the kos CLI sends it, and it signs short-lived
 * URLs, so KOS needs the value itself.
 */

/** The names a verifier is kept under. */
export type VerifierName = "hook";

const FILE = "verifiers.json";
const PEPPER = "verifier.pepper";

export class Verifiers {
  private readonly file: string;
  private readonly pepperPath: string;

  constructor(private readonly dir: string = join(homedir(), ".kos")) {
    this.file = join(dir, FILE);
    this.pepperPath = join(dir, PEPPER);
  }

  /** Whether a verifier is kept for `name`. */
  has(name: VerifierName): boolean {
    return this.read()[name] !== undefined;
  }

  /** Whether `given` is the value `name` was set to; false when none was. Compared in constant time. */
  matches(name: VerifierName, given: string): boolean {
    const kept = this.read()[name];
    if (!kept || !existsSync(this.pepperPath)) return false;
    const want = Buffer.from(kept, "base64");
    const got = this.verifierOf(given);
    return want.length === got.length && timingSafeEqual(want, got);
  }

  /** `name` checked against `value` from now on; null forgets it. */
  set(name: VerifierName, value: string | null): void {
    const all = this.read();
    if (value) all[name] = this.verifierOf(value, true).toString("base64");
    else delete all[name];
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeAtomic(this.file, `${JSON.stringify(all, null, 2)}\n`, this.dir);
  }

  private verifierOf(value: string, make = false): Buffer {
    return createHmac("sha256", this.pepper(make)).update(`kos-verifier/1|${value}`, "utf8").digest();
  }

  private pepper(make: boolean): Buffer {
    if (existsSync(this.pepperPath)) {
      const kept = Buffer.from(readPrivate(this.pepperPath).trim(), "base64");
      if (kept.length === 32) return kept;
    }
    if (!make) return Buffer.alloc(32);
    const fresh = randomBytes(32);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeAtomic(this.pepperPath, `${fresh.toString("base64")}\n`, this.dir);
    return fresh;
  }

  private read(): Partial<Record<VerifierName, string>> {
    if (!existsSync(this.file)) return {};
    try {
      const parsed = JSON.parse(readPrivate(this.file)) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Partial<Record<VerifierName, string>>) : {};
    } catch {
      return {};
    }
  }
}
