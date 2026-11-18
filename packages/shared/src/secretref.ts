/** True if the value holds any `{{secret:<name>}}` reference: a call that places a secret, which always asks. */
export function hasSecretRef(value: unknown): boolean {
  if (typeof value === "string") return /\{\{secret:[a-z0-9_.-]+\}\}/i.test(value);
  if (Array.isArray(value)) return value.some(hasSecretRef);
  if (value && typeof value === "object") return Object.values(value).some(hasSecretRef);
  return false;
}
