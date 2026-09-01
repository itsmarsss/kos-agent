/**
 * Secrets registry. The model never sees a secret value: the agent references
 * secrets by name, and the harness resolves the real value at call time. Values
 * live outside the workspace (process env, loaded from a gitignored .env), so
 * the jail already prevents the agent from reading them.
 *
 * Naming: a fixed map for first-class provider keys, plus any `KOS_SECRET_<NAME>`
 * env var exposed as secret `<name>` (lowercased) so integration keys can
 * accumulate without code changes.
 */

const PROVIDER_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

const KOS_SECRET_PREFIX = "KOS_SECRET_";

export class SecretsRegistry {
  private readonly map: Map<string, string>;

  constructor(entries: Record<string, string> = {}) {
    this.map = new Map(Object.entries(entries));
  }

  /** Build a registry from environment variables. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): SecretsRegistry {
    const entries: Record<string, string> = {};
    for (const [name, envVar] of Object.entries(PROVIDER_ENV)) {
      const value = env[envVar];
      if (value) entries[name] = value;
    }
    for (const [key, value] of Object.entries(env)) {
      if (key.startsWith(KOS_SECRET_PREFIX) && value) {
        const name = key.slice(KOS_SECRET_PREFIX.length).toLowerCase();
        entries[name] = value;
      }
    }
    return new SecretsRegistry(entries);
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

  /** Every registered secret name, so a reload can spot ones that went away. */
  names(): string[] {
    return [...this.map.keys()];
  }

  /** Forget a secret, as when the owner clears a key. */
  remove(name: string): void {
    this.map.delete(name);
  }

  /** Register or replace a secret (harness-side only). */
  set(name: string, value: string): void {
    this.map.set(name, value);
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
