import { registrableDomain, SECRET_FIELDS, type SecretFieldName } from "@kos/shared";

import { MIN_SCANNED, Scrubber, STREAM_REACH, type Watched } from "./scrub.js";
import { SHAPE_REACH, scrubShapes } from "./shapes.js";
import type { SecretCaller } from "./inject.js";
import type { Vault } from "./vault.js";

/**
 * Secrets registry. The model never sees a secret value: the agent references
 * secrets by name, and the harness resolves the real value at call time. Values
 * live outside the workspace (process env, loaded from a gitignored .env), so
 * the jail already prevents the agent from reading them.
 *
 * Naming: a fixed map for first-class provider keys, plus any `KOS_SECRET_<NAME>`
 * env var exposed as secret `<name>` (lowercased) so integration keys can
 * accumulate without code changes. Two suffixes are not secrets but where one
 * may go, both comma separated:
 * - `KOS_SECRET_<NAME>_HOSTS`: the hosts http.fetch may send it to, an entry
 *   `*.example.com` covering every subdomain. Without one it is not sent.
 * - `KOS_SECRET_<NAME>_MCP`: the MCP servers in mcp.json whose env, headers
 *   or url may carry it. Without one no server gets it.
 *
 * Other credentials the harness holds (a bot token, the dashboard token) are
 * never offered to the agent, but are still looked for by the scrubber.
 *
 * With a vault attached (vault.ts), its entries resolve too:
 * `{{secret:<handle>}}` is the kind's main field (a login's password, a
 * key's token), `{{secret:<handle>.<field>}}` any field, and an entry's
 * `use.http.hosts` binds it as `_HOSTS` does. Every vault value is
 * scrubbed. An env name wins over a handle; a handle always ends in four
 * random characters after a dash, so the two rarely meet.
 */

const PROVIDER_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

/** Where a provider key may be sent when the owner binds it nowhere else. */
const PROVIDER_HOSTS: Record<string, string[]> = {
  anthropic: ["api.anthropic.com"],
  openai: ["api.openai.com"],
};

const KOS_SECRET_PREFIX = "KOS_SECRET_";
const HOSTS_SUFFIX = "_HOSTS";
const MCP_SUFFIX = "_MCP";

/** Credentials the harness holds for itself: scrubbed, never placed. */
const HARNESS_ENV = ["DISCORD_BOT_TOKEN", "DISCORD_TOKEN", "KOS_DASHBOARD_TOKEN", "KOS_HOOK_SECRET", "KOS_CALLER_TOKEN", "TWILIO_AUTH_TOKEN", "AWS_SECRET_ACCESS_KEY", "KOS_DEVICE_HOST_KEY"];

/** Any other env var named like a credential is scrubbed too. */
const CREDENTIAL_NAMED = /(TOKEN|KEY|SECRET|PASSWORD)$/;

/** A watched value shorter than this is a flag or a name, not a credential, and would scrub ordinary words. */
const WATCHED_MIN = 16;

/** Where a secret may go. */
export interface SecretBinding {
  /** Hosts http.fetch may send it to. */
  hosts?: string[];
  /** MCP servers whose settings may carry it. */
  servers?: string[];
}

const list = (value: string): string[] => value.split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);

export class SecretsRegistry {
  private readonly map: Map<string, string>;
  private readonly bindings: Map<string, SecretBinding>;
  /** Values scrubbed but never placed: the harness's own credentials, by name. */
  private readonly watched: Map<string, string>;
  /** Watched values handed in at run time (a key file), kept across reloads. */
  private readonly kept = new Map<string, string>();
  /** Built on first use after any change, so it always looks for today's values. */
  private scrubber: Scrubber | undefined;
  /** The scrubber's values as the browser masks them, made again with the scrubber. */
  private masked: { by: Scrubber; values: { text: string; digits: boolean }[] } | undefined;
  private hits = 0;
  private vault: Vault | undefined;
  private unwatchVault: (() => void) | undefined;

  constructor(entries: Record<string, string> = {}, bindings: Record<string, SecretBinding> = {}, watched: Record<string, string> = {}) {
    this.map = new Map(Object.entries(entries));
    this.bindings = new Map(Object.entries(bindings));
    this.watched = new Map(Object.entries(watched));
  }

  /** Build a registry from environment variables. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): SecretsRegistry {
    const entries: Record<string, string> = {};
    const bindings: Record<string, SecretBinding> = {};
    for (const [name, envVar] of Object.entries(PROVIDER_ENV)) {
      const value = env[envVar];
      if (!value) continue;
      entries[name] = value;
      bindings[name] = { hosts: PROVIDER_HOSTS[name]! };
    }
    const bind = (name: string, part: SecretBinding): void => void (bindings[name] = { ...bindings[name], ...part });
    for (const [key, value] of Object.entries(env)) {
      if (!key.startsWith(KOS_SECRET_PREFIX) || !value) continue;
      const name = key.slice(KOS_SECRET_PREFIX.length).toLowerCase();
      if (key.endsWith(HOSTS_SUFFIX)) bind(name.slice(0, -HOSTS_SUFFIX.length), { hosts: list(value) });
      else if (key.endsWith(MCP_SUFFIX)) bind(name.slice(0, -MCP_SUFFIX.length), { servers: list(value) });
      else entries[name] = value;
    }
    const placed = new Set(Object.values(entries));
    const watched: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (!value || value.length < WATCHED_MIN || placed.has(value) || key.startsWith(KOS_SECRET_PREFIX)) continue;
      if (HARNESS_ENV.includes(key) || CREDENTIAL_NAMED.test(key)) watched[key.toLowerCase()] = value;
    }
    return new SecretsRegistry(entries, bindings, watched);
  }

  /** Read the vault's entries too, from now on; the scrubber follows every change to it. */
  attachVault(vault: Vault): void {
    this.unwatchVault?.();
    this.vault = vault;
    this.unwatchVault = vault.onChange(() => (this.scrubber = undefined));
    this.scrubber = undefined;
  }

  /** The vault its entries are read from, when one is attached: the secrets tools work on it. */
  attached(): Vault | undefined {
    return this.vault;
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  get(name: string): string | undefined {
    return this.map.get(name) ?? this.fromVault(name);
  }

  /**
   * Why a vault secret may not be used for this caller, if it may not:
   * never by a guest, in an unattended turn only when its policy says so,
   * and only in the chats its policy names. Env secrets have no policy.
   */
  policyRefusal(name: string, who: SecretCaller | undefined): string | undefined {
    const ref = this.map.has(name) ? undefined : this.vaultRef(name);
    const policy = ref ? this.vault!.get(ref.handle)?.policy : undefined;
    if (!policy) return undefined;
    if (who?.guest) return `Secret ${name} is the owner's; a guest's turn never uses one.`;
    if (!who?.attended && !policy.unattended) return `Secret ${name} needs the owner present: its policy keeps it from unattended turns.`;
    if (policy.chats && !(who?.conversationId && policy.chats.includes(who.conversationId))) return `Secret ${name} is not allowed in this chat.`;
    return undefined;
  }

  /** Whether `name` is a vault entry's handle (or one of its fields) rather than an env name. */
  inVault(name: string): boolean {
    return !this.map.has(name) && this.vaultRef(name) !== undefined;
  }

  /** The names KOS_SECRET_* and the provider keys go by, for a list of what the env file holds. */
  envNames(): string[] {
    return [...this.map.keys()].filter((name) => !(name in PROVIDER_ENV)).sort();
  }

  /** `<handle>` or `<handle>.<field>` split, the field the kind's main one when not named; undefined for no such entry. */
  private vaultRef(name: string): { handle: string; field: SecretFieldName } | undefined {
    if (!this.vault) return undefined;
    const [handle, field, extra] = name.toLowerCase().split(".");
    const meta = handle && extra === undefined ? this.vault.get(handle) : undefined;
    if (!meta) return undefined;
    const fields = SECRET_FIELDS[meta.kind];
    const chosen = (field ?? fields[0]) as SecretFieldName;
    return fields.includes(chosen) ? { handle: meta.handle, field: chosen } : undefined;
  }

  private fromVault(name: string): string | undefined {
    const ref = this.vaultRef(name);
    return ref ? this.vault!.value(ref.handle, ref.field) : undefined;
  }

  /** Resolve a secret value or throw if it is not registered. */
  require(name: string): string {
    const value = this.get(name);
    if (value === undefined) {
      throw new Error(`secret not found: ${name}`);
    }
    return value;
  }

  /** The hosts a secret may be sent to; undefined when it is bound to none. */
  hostsOf(name: string): string[] | undefined {
    const ref = this.map.has(name) ? undefined : this.vaultRef(name);
    const bound = ref ? this.vault!.get(ref.handle)?.use.http.hosts : this.bindings.get(name)?.hosts;
    return bound?.length ? bound : undefined;
  }

  /** The MCP servers a secret may be given to; undefined when it is bound to none. */
  serversOf(name: string): string[] | undefined {
    const bound = this.bindings.get(name)?.servers;
    return bound?.length ? bound : undefined;
  }

  /** Register or replace a secret (harness-side only). */
  set(name: string, value: string): void {
    this.map.set(name, value);
    this.scrubber = undefined;
  }

  /** A credential the harness read for itself (a key file): scrubbed from then on, never placed. */
  watch(name: string, value: string): void {
    this.kept.set(name, value);
    this.scrubber = undefined;
  }

  /**
   * Take on another registry's secrets, bindings and watched values, in
   * place: the router and every tool hold this object, so a reload must
   * change it, not replace it. Values handed to `watch` stay, and so
   * does the vault: its entries are read from it, not copied.
   */
  adopt(fresh: SecretsRegistry): void {
    for (const [mine, theirs] of [[this.map, fresh.map], [this.bindings, fresh.bindings], [this.watched, fresh.watched]] as const) {
      mine.clear();
      for (const [name, value] of theirs) (mine as Map<string, unknown>).set(name, value);
    }
    this.scrubber = undefined;
  }

  /**
   * Every value the scrubber looks for, as KOS's browser masks them in
   * every tab: the same strings, a card's by its digits. Made again only
   * when the scrubber is.
   */
  browserValues(): readonly { text: string; digits: boolean }[] {
    const by = this.scrubberNow();
    if (this.masked?.by !== by) this.masked = { by, values: this.scanned().map(([, text, mode]) => ({ text, digits: mode === "digits" })) };
    return this.masked.values;
  }

  /**
   * Whether a page origin is on a site a vault secret may be filled on (any
   * secret's web origins or frames, by registrable domain), where KOS runs
   * no script: one could read a copy the site keeps or wait for a fill.
   * Read from the vault each time, so it holds after a restart; a locked
   * vault cannot say which sites, so it holds every web origin.
   */
  evalBlocked(origin: string): boolean {
    const state = this.vault?.status().state;
    if (!this.vault || state === "absent") return false;
    const domain = siteDomain(origin);
    if (!domain) return false;
    if (state !== "ready") return /^https?:/i.test(origin);
    return this.vault.list().some((meta) => [...meta.use.web.origins, ...meta.use.web.frames].some((site) => siteDomain(site) === domain));
  }

  /** Every value the scrubber looks for, by name: secrets first, so a shared value keeps its secret's name. */
  private scanned(): Watched[] {
    return [...this.map, ...(this.vault?.scanned() ?? []), ...this.watched, ...this.kept];
  }

  private scrubberNow(): Scrubber {
    // A secret the CLI added while the host runs is looked for within a second.
    this.vault?.poll();
    this.scrubber ??= new Scrubber(this.scanned(), (name, count) => this.counted(name, count));
    return this.scrubber;
  }

  /**
   * `text` with every secret value, as it is or encoded, replaced by
   * `[secret <name>]`; see scrub.ts. For what a tool answered or a turn
   * shows, where a `{{secret:name}}` reference would read as an invitation.
   */
  scrub(text: string): string {
    return this.sweep(text).text;
  }

  /**
   * For text bound for the database: exact, and from the scrub index while
   * the vault is locked, but never by shape. A shape can match a timestamp
   * or an id, and a row's data must come back as it was written; a pasted
   * card is masked by shape at the door, before it is stored.
   */
  scrubStored(text: string): string {
    return this.sweep(text, false).text;
  }

  /**
   * Every value masked, and which: exactly by the scrubber, and while the
   * vault is shut, from its scrub index and by shape too, since its values
   * cannot be read to be looked for.
   */
  private sweep(text: string, shapes = true): { text: string; hits: Map<string, number>; shut: boolean } {
    const exact = this.scrubberNow().found(text);
    const shut = this.vault?.shut();
    if (!shut) return { ...exact, shut: false };
    const hits = new Map(exact.hits);
    let out = exact.text;
    for (const pass of [shut.index ? (t: string) => shut.index!.found(t) : undefined, shapes ? scrubShapes : undefined]) {
      if (!pass || out.length < MIN_SCANNED) continue;
      const found = pass(out);
      out = found.text;
      for (const [name, count] of found.hits) {
        hits.set(name, (hits.get(name) ?? 0) + count);
        this.counted(name, count);
      }
    }
    return { text: out, hits, shut: true };
  }

  private counted(name: string, count: number): void {
    this.hits += count;
    console.warn(`[secrets] took ${count} ${count === 1 ? "copy" : "copies"} of secret ${name} out of text bound for the model or a log`);
  }

  /** `text` scrubbed, and the names of the secrets found in it, for a door to tell the owner what it masked. */
  mask(text: string): { text: string; found: string[]; shut: boolean } {
    const { text: out, hits, shut } = this.sweep(text);
    return { text: out, found: [...hits.keys()], shut };
  }

  /** How much of a stream to hold back so no value is split across its pieces; see Scrubber.holdBack. */
  holdBack(): number {
    const exact = this.scrubberNow().holdBack;
    const shut = this.vault?.shut();
    // A stream holds back no more than an exact value's encoded forms would ask: a longer hold makes a live answer stutter.
    return shut ? Math.max(exact, Math.min(Math.max((shut.index?.reach ?? 0) - 1, SHAPE_REACH - 1), STREAM_REACH)) : exact;
  }

  /** How many values the scrubber has taken out since the host started: the Secrets page's leak counter. */
  scrubbed(): number {
    return this.hits;
  }

  /**
   * Replace every known secret value in `text` with its `{{secret:name}}`
   * reference, so secrets never leak into audit logs or run history.
   */
  redact(text: string): string {
    let out = text;
    for (const [name, value] of this.map) {
      if (value.length === 0) continue;
      out = out.split(value).join(`{{secret:${name}}}`);
    }
    return out;
  }
}

/** The registrable domain of an origin or a site pattern (`https://*.example.com`), or "" for none. */
function siteDomain(origin: string): string {
  const host = /^[a-z][a-z0-9+.-]*:\/\/(?:\*\.)?([^/:?#]+)/i.exec(origin)?.[1];
  return host ? registrableDomain(host) : "";
}
