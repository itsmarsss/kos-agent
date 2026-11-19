import { SECRET_TOOLS } from "./secrets.js";

/** True if the value holds any `{{secret:<name>}}` reference: a call that places a secret, which always asks. */
export function hasSecretRef(value: unknown): boolean {
  if (typeof value === "string") return /\{\{secret:[a-z0-9_.-]+\}\}/i.test(value);
  if (Array.isArray(value)) return value.some(hasSecretRef);
  if (value && typeof value === "object") return Object.values(value).some(hasSecretRef);
  return false;
}

/** True when a call places one of the owner's secrets: a reference in its arguments, or a secrets tool that fills one. */
export function usesSecret(tool: string, args: unknown): boolean {
  return SECRET_TOOLS.includes(tool) || hasSecretRef(args);
}
