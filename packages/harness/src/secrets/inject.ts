import type { SecretsRegistry } from "./secrets.js";

const SECRET_REF = /\{\{secret:([a-z0-9_.-]+)\}\}/gi;

/**
 * Substitute `{{secret:name}}` references with real secret values, at the
 * moment of the tool call, after the model has finished reasoning. The model
 * only ever sees the reference; the outbound request carries the real value.
 * An unknown secret name throws so a missing key fails loudly rather than
 * silently sending the placeholder.
 */
export function injectSecretsInString(
  text: string,
  secrets: SecretsRegistry,
): string {
  return text.replace(SECRET_REF, (_match, name: string) =>
    secrets.require(name),
  );
}

/**
 * Recursively inject secret references in every string within a value (tool
 * args). Objects and arrays are walked; other primitives pass through.
 */
export function injectSecrets<T>(value: T, secrets: SecretsRegistry): T {
  if (typeof value === "string") {
    return injectSecretsInString(value, secrets) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => injectSecrets(v, secrets)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = injectSecrets(v, secrets);
    }
    return out as unknown as T;
  }
  return value;
}

/** True if the value contains any `{{secret:...}}` reference. */
export function hasSecretRef(value: unknown): boolean {
  if (typeof value === "string") return /\{\{secret:[a-z0-9_.-]+\}\}/i.test(value);
  if (Array.isArray(value)) return value.some(hasSecretRef);
  if (value && typeof value === "object") {
    return Object.values(value).some(hasSecretRef);
  }
  return false;
}
