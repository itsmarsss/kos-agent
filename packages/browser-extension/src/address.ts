/**
 * Where KOS is, checked for a path the owner's pages can travel over.
 *
 * What crosses the connection is what is on the owner's pages, signed in.
 * So it goes encrypted: https anywhere, and plain http only where the
 * network already is private and encrypted, which is this computer itself
 * or a Tailscale tailnet. The same rule KOS Device keeps.
 */

/** Loopback, a Tailscale address (100.64.0.0/10, fd7a:115c:a1e0::/48) or a tailnet name. */
export function isPrivatePath(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (bare === "localhost" || bare === "::1" || bare.endsWith(".ts.net")) return true;
  if (bare.startsWith("fd7a:115c:a1e0:")) return true;
  const parts = bare.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return false;
  const [a, b] = parts.map(Number) as [number, number];
  return a === 127 || (a === 100 && b >= 64 && b <= 127);
}

/** The base address of a KOS, checked: no path, query or credentials, and an encrypted way there. */
export function kosAddress(text: string): string {
  const trimmed = text.trim();
  const withScheme = trimmed.includes("://") ? trimmed : `${isPrivatePath(new URL(`http://${trimmed}`).hostname) ? "http" : "https"}://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error("That is not an address. Paste the one KOS showed, like https://kos.example.ts.net.");
  }
  if (url.username || url.password) throw new Error("Leave the name and password out of the address.");
  if (url.protocol === "http:" && !isPrivatePath(url.hostname)) {
    throw new Error("Plain http only works for this computer or a Tailscale address. Put KOS behind https, or use its tailnet name.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("The address must start with https:// or http://.");
  return `${url.protocol}//${url.host}`;
}

/** The socket a device connects to. */
export function socketUrl(base: string): string {
  return `${base.replace(/^http/, "ws")}/api/devices/socket`;
}

export interface Pairing {
  url: string;
  code: string;
}

/** A pairing link as the dashboard gives it: kos-device://pair?url=...&code=... */
export function parsePairing(text: string): Pairing {
  let link: URL;
  try {
    link = new URL(text.trim());
  } catch {
    throw new Error("Paste the link KOS showed under Settings, Devices, Add a device.");
  }
  const url = link.searchParams.get("url");
  const code = link.searchParams.get("code");
  if (link.protocol !== "kos-device:" || !url || !code) throw new Error("That is not a KOS pairing link; it starts with kos-device://pair.");
  return { url: kosAddress(url), code: code.trim().toUpperCase() };
}
