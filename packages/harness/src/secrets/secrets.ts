import { registrableDomain, SECRET_FIELDS, type SecretFieldName } from "@kos/shared";

import { OneTimeCodes } from "./codes.js";
import { MIN_SCANNED, Scrubber, STREAM_REACH, type Watched } from "./scrub.js";
import { SHAPE_REACH, scrubShapes } from "./shapes.js";
import type { SecretCaller } from "./inject.js";
import type { SecretMeta, Vault } from "./vault.js";

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
 *
 * The keys KOS itself runs on (a provider's, a channel's) are read by their
 * harness name (`HARNESS_KEYS`): from the env when it has one, which always
 * wins, else from the vault's API key whose `use.harness` names it. Read at
 * each use, so a vault that opens after boot is used at once.
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

/**
 * The keys KOS itself runs on, by harness name, and the env names each is
 * read from, the canonical one first. Any `KOS_SECRET_<NAME>` is `<name>`
 * too. Names are the router's and the channels', never a provider's brand
 * in core logic: `custom` is whatever endpoint the owner set.
 */
export const HARNESS_KEYS: Readonly<Record<string, readonly string[]>> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  custom: ["KOS_SECRET_CUSTOM"],
  classifier: ["KOS_SECRET_CLASSIFIER"],
  cohere: ["KOS_SECRET_COHERE"],
  discord: ["KOS_SECRET_DISCORD", "DISCORD_TOKEN", "DISCORD_BOT_TOKEN"],
  twilio: ["KOS_SECRET_TWILIO", "TWILIO_AUTH_TOKEN"],
};

const KOS_SECRET_PREFIX = "KOS_SECRET_";
const HOSTS_SUFFIX = "_HOSTS";
const MCP_SUFFIX = "_MCP";

/** Credentials the harness holds for itself: scrubbed, never placed. */
export const HARNESS_ENV: readonly string[] = ["DISCORD_BOT_TOKEN", "DISCORD_TOKEN", "KOS_DASHBOARD_TOKEN", "KOS_HOOK_SECRET", "KOS_CALLER_TOKEN", "TWILIO_AUTH_TOKEN", "AWS_SECRET_ACCESS_KEY", "KOS_DEVICE_HOST_KEY"];

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

/** The harness name an env var holds a key under, or undefined: `KOS_SECRET_<NAME>` is `<name>`, its `_HOSTS` and `_MCP` are not keys. */
export function harnessNameOf(envName: string): string | undefined {
  for (const [name, envs] of Object.entries(HARNESS_KEYS)) if (envs.includes(envName)) return name;
  if (!envName.startsWith(KOS_SECRET_PREFIX) || envName.endsWith(HOSTS_SUFFIX) || envName.endsWith(MCP_SUFFIX)) return undefined;
  return envName.slice(KOS_SECRET_PREFIX.length).toLowerCase() || undefined;
}

/** Where a key KOS runs on is read from now: the env (under which name), or the vault (which secret). */
export type KeySource = { source: "env"; env: string } | { source: "vault"; handle: string; label: string };

export class SecretsRegistry {
  private readonly map: Map<string, string>;
  private readonly bindings: Map<string, SecretBinding>;
  /** Values scrubbed but never placed: the harness's own credentials, by name. */
  private readonly watched: Map<string, string>;
  /** The env's value of each harness key it has, and the name it was under. */
  private readonly harnessEnv: Map<string, { env: string; value: string }>;
  /** Watched values handed in at run time (a key file), kept across reloads. */
  private readonly kept = new Map<string, string>();
  /** Built on first use after any change, so it always looks for today's values. */
  private scrubber: Scrubber | undefined;
  /** The scrubber's values as the browser masks them, made with the scrubber from the same values: every one, and the vault's by the sites each may be filled on. */
  private masked: { all: BrowserValue[]; bySite: Map<string, BrowserValue[]> } = { all: [], bySite: new Map() };
  /** The registrable domains the vault's secrets may be filled on, as last seen. */
  private listed = new Set<string>();
  private readonly siteListeners = new Set<(domains: string[]) => void>();
  private hits = 0;
  private vault: Vault | undefined;
  private unwatchVault: (() => void) | undefined;
  /** The one-time codes the owner types on a card, held in memory alone and looked for while held (codes.ts). */
  readonly codes = new OneTimeCodes();

  constructor(entries: Record<string, string> = {}, bindings: Record<string, SecretBinding> = {}, watched: Record<string, string> = {}, harnessEnv: Record<string, { env: string; value: string }> = {}) {
    this.map = new Map(Object.entries(entries));
    this.bindings = new Map(Object.entries(bindings));
    this.watched = new Map(Object.entries(watched));
    this.harnessEnv = new Map(Object.entries(harnessEnv));
    this.codes.onChange(() => (this.scrubber = undefined));
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
    const harnessEnv: Record<string, { env: string; value: string }> = {};
    for (const [name, envs] of Object.entries(HARNESS_KEYS)) {
      const found = envs.find((e) => env[e]?.trim());
      if (found) harnessEnv[name] = { env: found, value: env[found]!.trim() };
    }
    return new SecretsRegistry(entries, bindings, watched, harnessEnv);
  }

  /** Read the vault's entries too, from now on; the scrubber follows every change to it. */
  attachVault(vault: Vault): void {
    this.unwatchVault?.();
    this.vault = vault;
    this.unwatchVault = vault.onChange(() => {
      this.scrubber = undefined;
      this.noteSites();
    });
    this.scrubber = undefined;
    this.noteSites();
  }

  /** The vault its entries are read from, when one is attached: the secrets tools work on it. */
  attached(): Vault | undefined {
    return this.vault;
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  get(name: string): string | undefined {
    // A harness key the env holds under a name the agent may not use (DISCORD_TOKEN) is not taken from the vault either.
    return this.map.get(name) ?? (this.harnessEnv.has(name) ? undefined : this.fromHarness(name)) ?? this.fromVault(name);
  }

  /**
   * A key KOS itself runs on (a provider's, a channel's), by harness name:
   * the env's when it has one, which always wins, else the vault's API key
   * whose `use.harness` names it, while the vault is open. Read at each use.
   */
  credential(name: string): string | undefined {
    return this.harnessEnv.get(name)?.value ?? this.map.get(name) ?? this.fromHarness(name);
  }

  /** Where a harness key is read from now, or undefined when neither the env nor the open vault has it. */
  sourceOf(name: string): KeySource | undefined {
    const env = this.harnessEnv.get(name)?.env ?? (this.map.has(name) ? `${KOS_SECRET_PREFIX}${name.toUpperCase()}` : undefined);
    if (env) return { source: "env", env };
    const meta = this.harnessMeta(name);
    return meta ? { source: "vault", handle: meta.handle, label: meta.label } : undefined;
  }

  /** The vault's API key KOS runs on under `name`, while the vault is open. */
  private harnessMeta(name: string): SecretMeta | undefined {
    return this.vault?.status().state === "ready" ? this.vault.harness(name) : undefined;
  }

  private fromHarness(name: string): string | undefined {
    const meta = this.harnessMeta(name);
    return meta ? this.vault!.value(meta.handle, "token") : undefined;
  }

  /** The vault entry a name means for the agent: a handle (or a field of one), else a harness name; env names never reach here. */
  private vaultMeta(name: string): SecretMeta | undefined {
    if (this.map.has(name)) return undefined;
    const ref = this.vaultRef(name);
    return ref ? this.vault!.get(ref.handle) : this.harnessMeta(name);
  }

  /**
   * Why a vault secret may not be used for this caller, if it may not:
   * never by a guest, in an unattended turn only when its policy says so,
   * and only in the chats its policy names. Env secrets have no policy.
   */
  policyRefusal(name: string, who: SecretCaller | undefined): string | undefined {
    const policy = this.vaultMeta(name)?.policy;
    if (!policy) return undefined;
    if (who?.guest) return `Secret ${name} is the owner's; a guest's turn never uses one.`;
    if (!who?.attended && !policy.unattended) return `Secret ${name} needs the owner present: its policy keeps it from unattended turns.`;
    if (policy.chats && !(who?.conversationId && policy.chats.includes(who.conversationId))) return `Secret ${name} is not allowed in this chat.`;
    return undefined;
  }

  /** Whether `name` is a vault entry's handle (or one of its fields) rather than an env name. */
  inVault(name: string): boolean {
    return this.vaultMeta(name) !== undefined;
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
    const meta = this.vaultMeta(name);
    // A harness key from the vault goes where the env's would when the entry names no hosts of its own.
    const own = meta?.use.http.hosts;
    const bound = own?.length ? own : meta && meta.use.harness !== name ? undefined : (this.bindings.get(name)?.hosts ?? (meta ? PROVIDER_HOSTS[name] : undefined));
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
    for (const [mine, theirs] of [[this.map, fresh.map], [this.bindings, fresh.bindings], [this.watched, fresh.watched], [this.harnessEnv, fresh.harnessEnv]] as const) {
      mine.clear();
      for (const [name, value] of theirs) (mine as Map<string, unknown>).set(name, value);
    }
    this.scrubber = undefined;
  }

  /**
   * Every value the scrubber looks for, as KOS's browser cleans what it
   * reads back: the same strings, a card's by its digits. The harness's own
   * keys among them: these stay in the host, never sent into a page.
   */
  browserValues(): readonly BrowserValue[] {
    this.scrubberNow();
    return this.masked.all;
  }

  /**
   * The vault's values whose secret may be filled on the site of one of
   * `origins` (by registrable domain): the only saved values a page of
   * that site is shown, to mask its pictures. A page elsewhere is shown
   * none, so it cannot learn which of its words is a saved secret.
   */
  pageValues(origins: readonly string[]): readonly BrowserValue[] {
    this.scrubberNow();
    const out = new Set<BrowserValue>();
    for (const origin of origins) for (const value of this.masked.bySite.get(siteDomain(origin)) ?? []) out.add(value);
    return [...out];
  }

  /**
   * Why no script of KOS's may run on a page origin, if none may: a vault
   * secret may be filled on its site (any secret's web origins or frames,
   * by registrable domain), where a script could read a copy the site keeps
   * or wait for a fill. Read from the vault each time, so it holds after a
   * restart; a locked vault cannot say which sites, so it holds every web
   * origin until it is unlocked.
   */
  evalBlocked(origin: string): string | undefined {
    const state = this.vault?.status().state;
    if (!this.vault || state === "absent") return undefined;
    const domain = siteDomain(origin);
    if (!domain) return undefined;
    if (state !== "ready") return /^https?:/i.test(origin) ? "the secrets vault is locked, so which sites hold a saved secret cannot be read; ask the owner to unlock it on the Secrets page" : undefined;
    return this.listedDomains().has(domain) ? "a saved secret may be filled on this site" : undefined;
  }

  /** The registrable domains a vault secret may be filled on now. */
  listedDomains(): Set<string> {
    if (this.vault?.status().state !== "ready") return new Set();
    return new Set(this.vault.list().flatMap((meta) => [...meta.use.web.origins, ...meta.use.web.frames].map(siteDomain).filter(Boolean)));
  }

  /** Told the domains newly listed for a secret, each time the vault lists one (an edit, allow_site, the CLI, an unlock). */
  onSitesListed(listener: (domains: string[]) => void): () => void {
    this.siteListeners.add(listener);
    return () => this.siteListeners.delete(listener);
  }

  private maskedOf(scanned: Watched[], vaulted: Set<Watched>, codeSites: Map<Watched, string>): { all: BrowserValue[]; bySite: Map<string, BrowserValue[]> } {
    const all: BrowserValue[] = [];
    const bySite = new Map<string, BrowserValue[]>();
    for (const entry of scanned) {
      const [name, text, mode] = entry;
      const value = { text, digits: mode === "digits" };
      all.push(value);
      const meta = vaulted.has(entry) ? this.vault?.get(name.split(".")[0] ?? "") : undefined;
      const sites = meta ? [...meta.use.web.origins, ...meta.use.web.frames] : codeSites.has(entry) ? [codeSites.get(entry)!] : [];
      for (const domain of new Set(sites.map(siteDomain))) {
        if (domain) bySite.set(domain, [...(bySite.get(domain) ?? []), value]);
      }
    }
    return { all, bySite };
  }

  private noteSites(): void {
    const now = this.listedDomains();
    const fresh = [...now].filter((d) => !this.listed.has(d));
    this.listed = now;
    if (fresh.length) for (const listener of this.siteListeners) listener(fresh);
  }

  private scrubberNow(): Scrubber {
    // A secret the CLI added while the host runs is looked for within a second.
    this.vault?.poll();
    if (!this.scrubber) {
      // One read of the vault's values, for the scrubber and the browser both: no second copy is decrypted.
      const vaulted = this.vault?.scanned() ?? [];
      // A code held for a page is shown to that page's site alone, to mask its pictures, as a vault value is.
      const codeSites = new Map<Watched, string>();
      const codes = this.codes.watched().map(({ handle, value, origin }) => {
        const entry: Watched = [`${handle}.code`, value, "code"];
        if (origin) codeSites.set(entry, origin);
        return entry;
      });
      // Every value the scrubber looks for, by name: secrets first, so a shared value keeps its secret's name.
      const scanned: Watched[] = [...this.map, ...vaulted, ...codes, ...this.watched, ...this.kept];
      this.scrubber = new Scrubber(scanned, (name, count) => this.counted(name, count));
      this.masked = this.maskedOf(scanned, new Set(vaulted), codeSites);
    }
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

/** A value as KOS's browser looks for it: a card's by its digits. */
export interface BrowserValue {
  text: string;
  digits: boolean;
}

/** The registrable domain of an origin or a site pattern (`https://*.example.com`), or "" for none. */
function siteDomain(origin: string): string {
  const host = /^[a-z][a-z0-9+.-]*:\/\/(?:\*\.)?([^/:?#]+)/i.exec(origin)?.[1];
  return host ? registrableDomain(host) : "";
}
