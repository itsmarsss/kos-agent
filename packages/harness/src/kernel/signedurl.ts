/**
 * Signed addresses for what a browser fetches by itself: an `<img src>`, a
 * player, a framed PDF send no headers, so with a dashboard token they could
 * not carry it. KOS signs the exact address for a holder of the token, for a
 * few minutes, and the token itself never goes into a URL.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** The query parameter a signed address ends with. */
export const SIGNATURE_PARAM = "kos_sig";

/** How long a signed address is good for: long enough for a film to be played through, short enough to be useless once seen in a log. */
export const SIGNED_URL_TTL_MS = 15 * 60_000;

const SIGNED = new RegExp(`[?&]${SIGNATURE_PARAM}=(\\d+)\\.([A-Za-z0-9_-]+)$`);

function macOf(token: string, expires: number, url: string): Buffer {
  // A key of its own, made from the token, so a signature says nothing of the token.
  const key = createHmac("sha256", token).update("kos-signed-url").digest();
  return createHmac("sha256", key).update(`${expires}\n${url}`).digest();
}

/** `url` (a path and its query) good for a GET until `now + ttl`. */
export function signUrl(url: string, token: string, now = Date.now(), ttl = SIGNED_URL_TTL_MS): string {
  const expires = now + ttl;
  const mac = macOf(token, expires, url).toString("base64url");
  return `${url}${url.includes("?") ? "&" : "?"}${SIGNATURE_PARAM}=${expires}.${mac}`;
}

/** Whether `url` is an address KOS signed with this token, unchanged and not yet past its time. */
export function signedUrlValid(url: string, token: string, now = Date.now()): boolean {
  const found = SIGNED.exec(url);
  if (!found) return false;
  const expires = Number(found[1]);
  if (!Number.isSafeInteger(expires) || expires < now) return false;
  const given = Buffer.from(found[2]!, "base64url");
  const want = macOf(token, expires, url.slice(0, found.index));
  return given.length === want.length && timingSafeEqual(given, want);
}
