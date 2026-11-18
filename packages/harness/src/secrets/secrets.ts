import { Scrubber } from "./scrub.js";

/**
 * Secrets registry. The model never sees a secret value: the agent references
 * secrets by name, and the harness resolves the real value at call time. Values
 * live outside the workspace (process env, loaded from a gitignored .env), so
 * the jail already prevents the agent from reading them.
 *
 * Naming: a fixed map for first-class provider keys, plus any `KOS_SECRET_<NAME>`
 * env var exposed as secret `<name>` (lowercased) so integration keys can
 * accumulate without code changes. `KOS_SECRET_<NAME>_HOSTS` is not a secret:
 * it binds `<name>` to the hosts it may be sent to, comma separated, an entry
 * `*.example.com` covering every subdomain.
 */

const PROVIDER_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

const KOS_SECRET_PREFIX = "KOS_SECRET_";
const HOSTS_SUFFIX = "_HOSTS";

export class SecretsRegistry {
  private readonly map: Map<string, string>;
  private readonly hosts: Map<string, string[]>;
  /** Built on first use after any change, so it always looks for today's values. */
  private scrubber: Scrubber | undefined;
  private hits = 0;

  constructor(entries: Record<string, string> = {}, hosts: Record<string, string[]> = {}) {
    this.map = new Map(Object.entries(entries));
    this.hosts = new Map(Object.entries(hosts));
  }

  /** Build a registry from environment variables. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): SecretsRegistry {
    const entries: Record<string, string> = {};
    for (const [name, envVar] of Object.entries(PROVIDER_ENV)) {
      const value = env[envVar];
      if (value) entries[name] = value;
    }
    const hosts: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(env)) {
      if (!key.startsWith(KOS_SECRET_PREFIX) || !value) continue;
      const name = key.slice(KOS_SECRET_PREFIX.length).toLowerCase();
      if (key.endsWith(HOSTS_SUFFIX)) {
        hosts[name.slice(0, -HOSTS_SUFFIX.length)] = value.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
      } else {
        entries[name] = value;
      }
    }
    return new SecretsRegistry(entries, hosts);
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
    const bound = this.hosts.get(name);
    return bound?.length ? bound : undefined;
  }

  /** Register or replace a secret (harness-side only). */
  set(name: string, value: string): void {
    this.map.set(name, value);
    this.scrubber = undefined;
  }

  /**
   * Take on another registry's secrets and bindings, in place: the router and
   * every tool hold this object, so a reload must change it, not replace it.
   */
  adopt(fresh: SecretsRegistry): void {
    this.map.clear();
    this.hosts.clear();
    for (const [name, value] of fresh.map) this.map.set(name, value);
    for (const [name, hosts] of fresh.hosts) this.hosts.set(name, hosts);
    this.scrubber = undefined;
  }

  /**
   * `text` with every secret value, as it is or encoded, replaced by
   * `[secret <name>]`; see scrub.ts. For what a tool answered or a turn
   * shows, where a `{{secret:name}}` reference would read as an invitation.
   */
  scrub(text: string): string {
    this.scrubber ??= new Scrubber(this.map, (name, count) => {
      this.hits += count;
      console.warn(`[secrets] took ${count} ${count === 1 ? "copy" : "copies"} of secret ${name} out of text bound for the model or a log`);
    });
    return this.scrubber.scrub(text);
  }

  /** How many values the scrubber has taken out since the host started. */
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
