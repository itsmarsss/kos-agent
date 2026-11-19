/**
 * Signed addresses for what a browser fetches by itself: an `<img src>`, a
 * player, a framed PDF, the dashboard's socket send no headers, so with a
 * dashboard token they could not carry it. KOS signs the exact address for a
 * holder of the token, for a while, and the token itself never goes into a
 * URL. Only the routes the dashboard points an element at can be signed, and
 * only those take a signature: none opens anything else.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** The query parameter a signed address ends with. */
export const SIGNATURE_PARAM = "kos_sig";

/** An image or a thumbnail: drawn once, signed again by the page before this runs out or when it fails. */
export const SIGNED_URL_TTL_MS = 15 * 60_000;
/** A film, a sound or a framed PDF fetches in ranges for as long as it is open, and signing it again would start it over. */
export const SIGNED_MEDIA_TTL_MS = 6 * 60 * 60_000;
/** The socket's ticket: spent on the connection it opens, a minute at most. */
export const SOCKET_TICKET_TTL_MS = 60_000;

/** The routes the dashboard signs, each with how long its signature lasts. */
const SIGNABLE: readonly { route: RegExp; ttl: number }[] = [
  { route: /^\/api\/file\/raw$/, ttl: SIGNED_URL_TTL_MS },
  { route: /^\/api\/file\/view(\/[^/]+)?$/, ttl: SIGNED_MEDIA_TTL_MS },
  { route: /^\/api\/file\/media$/, ttl: SIGNED_MEDIA_TTL_MS },
  { route: /^\/api\/artifacts\/[^/]+\/thumb$/, ttl: SIGNED_URL_TTL_MS },
  { route: /^\/api\/approvals\/\d+\/picture$/, ttl: SIGNED_URL_TTL_MS },
  { route: /^\/api\/frames\/[^/]+$/, ttl: SIGNED_URL_TTL_MS },
  { route: /^\/api\/socket$/, ttl: SOCKET_TICKET_TTL_MS },
];

/** How long a signature on `url`'s route lasts, or undefined for a route that is never signed. */
export function signingTtl(url: string): number | undefined {
  const path = url.split("?")[0] ?? "";
  return SIGNABLE.find((s) => s.route.test(path))?.ttl;
}

const SIGNED = new RegExp(`[?&]${SIGNATURE_PARAM}=(\\d+)\\.([A-Za-z0-9_-]+)$`);

function macOf(token: string, expires: number, url: string): Buffer {
  // A key of its own, made from the token, so a signature says nothing of the token.
  const key = createHmac("sha256", token).update("kos-signed-url").digest();
  return createHmac("sha256", key).update(`${expires}\n${url}`).digest();
}

/** `url` (a path and its query) signed for a GET until its route's time runs out, or undefined for a route that is never signed. */
export function signUrl(url: string, token: string, now = Date.now()): { url: string; expiresAt: number } | undefined {
  const ttl = signingTtl(url);
  if (ttl === undefined) return undefined;
  const expiresAt = now + ttl;
  const mac = macOf(token, expiresAt, url).toString("base64url");
  return { url: `${url}${url.includes("?") ? "&" : "?"}${SIGNATURE_PARAM}=${expiresAt}.${mac}`, expiresAt };
}

/** The signature `url` ends with, when it is one KOS made with this token for a signable route, unchanged and not yet past its time. */
export function validSignature(url: string, token: string, now = Date.now()): string | undefined {
  const found = SIGNED.exec(url);
  if (!found) return undefined;
  const base = url.slice(0, found.index);
  if (signingTtl(base) === undefined) return undefined;
  const expires = Number(found[1]);
  if (!Number.isSafeInteger(expires) || expires < now) return undefined;
  const given = Buffer.from(found[2]!, "base64url");
  const want = macOf(token, expires, base);
  return given.length === want.length && timingSafeEqual(given, want) ? found[2] : undefined;
}

/** Whether `url` is an address KOS signed with this token, unchanged and not yet past its time. */
export function signedUrlValid(url: string, token: string, now = Date.now()): boolean {
  return validSignature(url, token, now) !== undefined;
}
