/**
 * Flat {var} substitution against a flat scope. Not a path language: a single
 * pass of string replace. Values are pre-formatted in SQL (money, dates,
 * percent), so the templater stays dumb. A null or missing value uses the
 * fallback so a notify never sends "null".
 */
export function template(
  text: string,
  scope: Record<string, unknown>,
  fallback = "",
): string {
  return text.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = scope[key];
    return value === undefined || value === null ? fallback : String(value);
  });
}

/** Apply templating to every string value in a tool call's args (shallow). */
export function templateArgs(
  args: Record<string, unknown>,
  scope: Record<string, unknown>,
  fallback = "",
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = typeof v === "string" ? template(v, scope, fallback) : v;
  }
  return out;
}
