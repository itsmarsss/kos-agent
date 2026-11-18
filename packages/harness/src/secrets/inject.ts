import type { SecretsRegistry } from "./secrets.js";

const SECRET_REF = /\{\{secret:([a-z0-9_.-]+)\}\}/gi;

/**
 * Where a tool's arguments may carry a `{{secret:name}}` reference.
 *
 * A reference anywhere else is refused, never expanded: a value put in a
 * notification, a file or a page would leave the harness in a place nothing
 * was declared for, and the model could read it back. Only http.fetch
 * declares slots among tools; an MCP server's config declares its env and
 * headers.
 */
export interface SecretSlots {
  /** Argument paths, dot-separated, `*` standing for any one key: `headers.*`. */
  paths: string[];
  /** Of those paths, the ones holding a URL, where a reference may stand only in the query string. */
  urls?: string[];
  /** Where the call goes, checked against the hosts each secret is bound to. */
  host?: (input: Record<string, unknown>) => string | undefined;
}

/** The arguments with every reference expanded, or why the call is refused. */
export type Placed = { input: Record<string, unknown> } | { refused: string };

/** True if the value contains any `{{secret:...}}` reference. */
export function hasSecretRef(value: unknown): boolean {
  if (typeof value === "string") return /\{\{secret:[a-z0-9_.-]+\}\}/i.test(value);
  if (Array.isArray(value)) return value.some(hasSecretRef);
  if (value && typeof value === "object") return Object.values(value).some(hasSecretRef);
  return false;
}

function matches(pattern: string, path: string[]): boolean {
  const parts = pattern.split(".");
  return parts.length === path.length && parts.every((part, i) => part === "*" || part === path[i]);
}

/** Whether `host` is one of `bound`, an entry `*.example.com` covering its subdomains. */
function hostAllowed(host: string, bound: string[]): boolean {
  return bound.some((entry) => (entry.startsWith("*.") ? host.endsWith(entry.slice(1)) : host === entry));
}

/** Whether every reference in a URL lies in its query string. */
function inQuery(url: string): boolean {
  const query = url.indexOf("?");
  const fragment = url.indexOf("#", query + 1);
  return [...url.matchAll(SECRET_REF)].every(({ index }) => query >= 0 && index > query && (fragment < 0 || index < fragment));
}

/**
 * A tool call's arguments with each `{{secret:name}}` reference expanded,
 * where its tool declared a slot for one and the secret may go where the call
 * goes; otherwise why the call is refused. Run at the moment of the call,
 * after the model has finished reasoning, so it only ever saw the reference.
 */
export function placeSecrets(tool: string, input: Record<string, unknown>, slots: SecretSlots | undefined, secrets: SecretsRegistry): Placed {
  if (!hasSecretRef(input)) return { input };
  let refused: string | undefined;
  const refuse = (why: string): string => {
    refused ??= `${why} Nothing was sent. In a tool call a {{secret:name}} reference works only in an http.fetch header or its URL's query string.`;
    return "";
  };
  const walk = (value: unknown, path: string[]): unknown => {
    if (Array.isArray(value)) return value.map((item: unknown, i) => walk(item, [...path, String(i)]));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item, [...path, key])]));
    }
    if (typeof value !== "string" || !hasSecretRef(value)) return value;
    const where = path.join(".");
    if (!slots?.paths.some((pattern) => matches(pattern, path))) return refuse(`${tool} takes no secret in ${where || "its input"}.`);
    const url = slots.urls?.some((pattern) => matches(pattern, path)) === true;
    if (url && !inQuery(value)) return refuse(`A secret in ${tool}'s ${where} may stand only in the query string.`);
    return value.replace(SECRET_REF, (_match, name: string) => {
      const secret = secrets.get(name);
      if (secret === undefined) return refuse(`There is no secret named ${name}.`);
      const bound = secrets.hostsOf(name);
      const host = slots.host?.(input);
      if (bound && (!host || !hostAllowed(host, bound))) return refuse(`Secret ${name} may be sent only to ${bound.join(", ")}, not ${host ?? "an unknown host"}.`);
      return url ? encodeURIComponent(secret) : secret;
    });
  };
  const placed = walk(input, []) as Record<string, unknown>;
  return refused === undefined ? { input: placed } : { refused };
}
