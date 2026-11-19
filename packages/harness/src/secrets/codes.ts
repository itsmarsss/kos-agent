import { randomBytes } from "node:crypto";

import { CODE_HANDLE, CODE_TTL_MS, codeProblem, ONE_TIME_CODE, typedCode, type SecretSurface } from "@kos/shared";

/**
 * One-time codes, in the host's memory alone. A code is never saved: the
 * owner types it into the card of the fill or the type that needs it, the
 * yes hands it here under the ask's id, and the approved call takes it as a
 * handle `otp_<id>` bound to the page or the app it was asked for and the
 * chat that asked. A handle is used once, within CODE_TTL_MS of the yes. A
 * refusal known to come before the value reached the page leaves it for one
 * more try, and one only, into the same field of the same document (its
 * pin); anything else spends it.
 *
 * The value is watched for by the scrubber for as long as it is held, and
 * for CODE_TTL_MS after it was used or ran out, so a page that echoes it is
 * cleaned; then it is dropped.
 */

/** What a one-time code's card calls it. */
export const CODE_LABEL = "One-time code";

/** Whether a call names a one-time code, to ask for (`code`) or one given already (`otp_<id>`). */
export function namesCode(input: Record<string, unknown>): boolean {
  const named = typeof input["secret"] === "string" ? input["secret"].trim().toLowerCase() : "";
  return named === ONE_TIME_CODE || CODE_HANDLE.test(named);
}

/** Where a code may go, read from the tab or the Mac when the owner was asked, never from the model. */
export interface CodeBinding {
  surface: SecretSurface;
  conversationId: string;
  /** The page's origin; none for a field in an app that is not a browser. */
  origin?: string;
  /** The Mac app's bundle id, for a code typed on a Mac. */
  app?: string;
}

/** Why a handle cannot be used where it is asked for. */
export type CodeRefusal = { code: "secret" | "expired" | "used" | "policy" | "origin"; why: string };

interface Held {
  value: string;
  approval: number;
  bound?: CodeBinding;
  /** Until when it may be used. */
  expires: number;
  /** Until when echoes of it are still taken out. */
  watched: number;
  spent: boolean;
  /** Times it was handed out to be placed: once, and a second time only for its one retry. */
  tries: number;
  /** The field of the document its one retry may go into, once its first try was refused before it went in. */
  pin?: string;
}

export class OneTimeCodes {
  private readonly held = new Map<string, Held>();
  private readonly listeners = new Set<() => void>();
  private sweeper: NodeJS.Timeout | undefined;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Told whenever the values held change, so the scrubber looks for today's. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * The code the owner typed with their yes to ask `approval`, or why it is
   * not one. Held unbound until the approved call takes it.
   */
  offer(approval: number, typed: string): string | undefined {
    const problem = codeProblem(typed);
    if (problem) return problem;
    this.sweep();
    for (const [handle, code] of this.held) if (code.approval === approval) this.held.delete(handle);
    const at = this.now();
    this.held.set(`otp_${randomBytes(4).toString("hex")}`, { value: typedCode(typed), approval, expires: at + CODE_TTL_MS, watched: at + 2 * CODE_TTL_MS, spent: false, tries: 0 });
    this.changed();
    return undefined;
  }

  /** The handle of the code given with ask `approval`, bound from now on to where it was asked for; once. */
  claim(approval: number, binding: CodeBinding): string | undefined {
    this.sweep();
    for (const [handle, code] of this.held) {
      if (code.approval !== approval || code.bound || code.spent || code.expires <= this.now()) continue;
      code.bound = binding;
      this.changed();
      return handle;
    }
    return undefined;
  }

  /**
   * Whether the code `handle` may go where `at` says, into the field `pin`
   * names, and why not when it may not. Once handed out it goes again only
   * as its one retry, into the field it was pinned to.
   */
  check(handle: string, at: CodeBinding, pin: string): CodeRefusal | undefined {
    this.sweep();
    const code = this.held.get(handle);
    if (!code?.bound) return { code: "secret", why: `There is no one-time code ${JSON.stringify(handle)}. Ask for one with secret "code".` };
    if (code.spent || (code.tries > 0 && code.pin === undefined)) return { code: "used", why: `The one-time code ${handle} was used already; a code goes in once. Ask for a new one with secret "code".` };
    if (code.expires <= this.now()) return { code: "expired", why: `The one-time code ${handle} ran out (a code is good for ${CODE_TTL_MS / 60_000} minutes). Ask for a new one with secret "code".` };
    const bound = code.bound;
    if (bound.conversationId !== at.conversationId) return { code: "policy", why: `The one-time code ${handle} was given to another chat.` };
    if (bound.surface !== at.surface || (bound.app ?? null) !== (at.app ?? null)) return { code: "origin", why: `The one-time code ${handle} was given for ${placeWords(bound)}, not here.` };
    if ((bound.origin ?? null) !== (at.origin ?? null)) return { code: "origin", why: `The one-time code ${handle} was given for ${bound.origin ?? "a field outside a page"}, not ${at.origin ?? "here"}.` };
    if (code.pin !== undefined && code.pin !== pin) return { code: "origin", why: `The one-time code ${handle} may go again only into the field it was refused by, on the same page; look again, or ask for a new one.` };
    return undefined;
  }

  /** The value of `handle`, for the one call that places it, when `check` passes: a try counted. */
  value(handle: string, at: CodeBinding, pin: string): string | CodeRefusal {
    const refused = this.check(handle, at, pin);
    if (refused) return refused;
    const code = this.held.get(handle)!;
    code.tries += 1;
    code.pin = undefined;
    return code.value;
  }

  /**
   * Its try refused before the value reached the page or the field: kept
   * for one retry into `pin` after a first try, spent after a retry.
   */
  refusedBefore(handle: string, pin: string): void {
    const code = this.held.get(handle);
    if (!code || code.spent) return;
    if (code.tries === 1) code.pin = pin;
    else this.spend(handle);
  }

  /** Whether `handle` has its one retry open, into the field `pin` names. */
  retryOpen(handle: string, pin: string): boolean {
    const code = this.held.get(handle);
    return code !== undefined && !code.spent && code.pin === pin;
  }

  /** `handle` used: never again, and watched for a while longer, then dropped. */
  spend(handle: string): void {
    const code = this.held.get(handle);
    if (!code || code.spent) return;
    code.spent = true;
    code.watched = Math.min(code.watched, this.now() + CODE_TTL_MS);
    this.changed();
  }

  /** How long `handle` may still be used, in whole minutes rounded up; 0 for gone. */
  minutesLeft(handle: string): number {
    const code = this.held.get(handle);
    return code && !code.spent ? Math.max(0, Math.ceil((code.expires - this.now()) / 60_000)) : 0;
  }

  /** Every value watched for now: its handle, the value, and the page origin it was bound to, if any. */
  watched(): { handle: string; value: string; origin?: string }[] {
    this.sweep();
    return [...this.held].map(([handle, code]) => ({ handle, value: code.value, ...(code.bound?.origin ? { origin: code.bound.origin } : {}) }));
  }

  /** Everything forgotten: the host stopping. */
  clear(): void {
    this.held.clear();
    if (this.sweeper) clearTimeout(this.sweeper);
    this.sweeper = undefined;
    this.changed();
  }

  /** Codes no longer watched, dropped; a timer set for the next to go. */
  private sweep(): void {
    const at = this.now();
    let dropped = false;
    for (const [handle, code] of this.held) {
      if (code.watched > at) continue;
      this.held.delete(handle);
      dropped = true;
    }
    if (dropped) this.changed();
  }

  private changed(): void {
    if (this.sweeper) clearTimeout(this.sweeper);
    this.sweeper = undefined;
    const next = Math.min(...[...this.held.values()].map((c) => c.watched));
    if (Number.isFinite(next)) {
      this.sweeper = setTimeout(() => this.sweep(), Math.max(0, next - this.now()) + 10);
      this.sweeper.unref?.();
    }
    for (const listener of this.listeners) listener();
  }
}

function placeWords(binding: CodeBinding): string {
  if (binding.app) return `the app ${binding.app}`;
  return binding.surface === "chrome" ? "the owner's Chrome" : binding.surface === "mac" ? "the Mac" : "KOS's own browser";
}
