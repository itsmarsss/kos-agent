import { Scrubber } from "./scrub.js";

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
  private hits = 0;

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
      if (!value || placed.has(value) || key.startsWith(KOS_SECRET_PREFIX)) continue;
      if (HARNESS_ENV.includes(key) || CREDENTIAL_NAMED.test(key)) watched[key.toLowerCase()] = value;
    }
    return new SecretsRegistry(entries, bindings, watched);
  }

  has(name: string): boolean {
    return this.map.has(name);
  }

  get(name: string): string | undefined {
    return this.map.get(name);
  }

  /** Resolve a secret value or throw if it is not registered. */
  require(name: string): string {
    const value = this.map.get(name);
    if (value === undefined) {
      throw new Error(`secret not found: ${name}`);
    }
    return value;
  }

  /** The hosts a secret may be sent to; undefined when it is bound to none. */
  hostsOf(name: string): string[] | undefined {
    const bound = this.bindings.get(name)?.hosts;
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
   * change it, not replace it. Values handed to `watch` stay.
   */
  adopt(fresh: SecretsRegistry): void {
    for (const [mine, theirs] of [[this.map, fresh.map], [this.bindings, fresh.bindings], [this.watched, fresh.watched]] as const) {
      mine.clear();
      for (const [name, value] of theirs) (mine as Map<string, unknown>).set(name, value);
    }
    this.scrubber = undefined;
  }

  /** Every value the scrubber looks for, by name: secrets first, so a shared value keeps its secret's name. */
  private scanned(): [string, string][] {
    return [...this.map, ...this.watched, ...this.kept];
  }

  private scrubberNow(): Scrubber {
    this.scrubber ??= new Scrubber(this.scanned(), (name, count) => {
      this.hits += count;
      console.warn(`[secrets] took ${count} ${count === 1 ? "copy" : "copies"} of secret ${name} out of text bound for the model or a log`);
    });
    return this.scrubber;
  }

  /**
   * `text` with every secret value, as it is or encoded, replaced by
   * `[secret <name>]`; see scrub.ts. For what a tool answered or a turn
   * shows, where a `{{secret:name}}` reference would read as an invitation.
   */
  scrub(text: string): string {
    return this.scrubberNow().scrub(text);
  }

  /** How much of a stream to hold back so no value is split across its pieces; see Scrubber.holdBack. */
  holdBack(): number {
    return this.scrubberNow().holdBack;
  }

  /**
   * How many values the scrubber has taken out since the host started.
   * Kept for the Secrets page (unit 5 of the secrets design); nothing shows it yet.
   */
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
