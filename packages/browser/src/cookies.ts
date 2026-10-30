/**
 * Signed in, and still signed in tomorrow.
 *
 * Chrome forgets a cookie with no expiry, a session cookie, when it quits,
 * and many sites keep a sign-in in one. KOS's Chrome quits whenever KOS
 * restarts, so the owner signed in and was signed out again by the next
 * update. Chrome's "continue where you left off" keeps them, but not when it
 * runs headless. So KOS gives each session cookie an expiry of its own, and
 * Chrome keeps it with its other cookies, encrypted, in the profile. A site
 * that signs the owner out still clears it, and one that sets it again gets
 * it kept again.
 */

/** How long a kept session cookie lives, from the last time it was kept. */
export const KEEP_DAYS = 30;

/** A cookie as `Storage.getCookies` reports it, as much as is read here. */
export interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  session: boolean;
  sameSite?: string;
  priority?: string;
  sourceScheme?: string;
  sourcePort?: number;
  partitionKey?: unknown;
}

/**
 * The session cookies among `cookies`, as `Storage.setCookies` would set
 * them again with an expiry. Everything else about each is kept as it was.
 */
export function keptSessionCookies(cookies: CdpCookie[], now: number): Record<string, unknown>[] {
  const expires = Math.floor(now / 1000) + KEEP_DAYS * 86_400;
  return cookies
    .filter((c) => c.session)
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      expires,
      ...(c.sameSite ? { sameSite: c.sameSite } : {}),
      ...(c.priority ? { priority: c.priority } : {}),
      ...(c.sourceScheme ? { sourceScheme: c.sourceScheme } : {}),
      ...(typeof c.sourcePort === "number" ? { sourcePort: c.sourcePort } : {}),
      ...(c.partitionKey ? { partitionKey: c.partitionKey } : {}),
    }));
}
