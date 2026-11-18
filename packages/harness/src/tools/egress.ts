import { lookup, type LookupAddress } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";

/**
 * Where a fetch the agent makes may not go: this machine, the networks
 * around it, and KOS itself.
 *
 * KOS's own API listens on loopback, and a request from a program carries no
 * Origin, so a fetch to 127.0.0.1 could set a chat to Auto or approve the
 * agent's own ask. Every address a name resolves to is checked, at the
 * moment of connecting, so a name that answers a public address to the check
 * and a private one to the connection (DNS rebinding) is refused too.
 */
const PRIVATE = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const) {
  PRIVATE.addSubnet(net, bits, "ipv4");
}
for (const [net, bits] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  PRIVATE.addSubnet(net, bits, "ipv6");
}

/** An IPv4 address an IPv6 one carries (::ffff:127.0.0.1), or the address itself. */
function unmapped(address: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return m ? m[1]! : address;
}

/** Whether an address is this machine or a network around it: loopback, private, link-local, and the like. */
export function blockedAddress(address: string): boolean {
  const plain = unmapped(address.replace(/^\[|\]$/g, ""));
  const family = isIP(plain);
  if (family === 0) return true;
  return PRIVATE.check(plain, family === 4 ? "ipv4" : "ipv6");
}

/** Hosts that are this machine by name alone. */
const LOCAL_NAMES = /^(localhost|localhost\.localdomain|ip6-localhost|ip6-loopback)$|\.localhost$|\.local$|\.internal$/i;

/**
 * Why a url may not be fetched, before anything is resolved, or undefined:
 * not http(s), a local name, an address literal that is local, or one of
 * KOS's own hosts (`own`, host or host:port as it is reached).
 */
export function refusedUrl(raw: string, own: readonly string[] = []): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `not a url: ${raw}`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return `${url.protocol} is not fetched; only http and https`;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  if (own.some((o) => o.toLowerCase() === host || o.toLowerCase() === `${host}:${port}`)) return `${url.host} is KOS itself, which http.fetch never reaches`;
  if (LOCAL_NAMES.test(host)) return `${url.host} is this machine, which http.fetch never reaches`;
  if (isIP(unmapped(host)) && blockedAddress(host)) return `${url.host} is this machine or its local network, which http.fetch never reaches`;
  return undefined;
}

/**
 * A dns lookup for the connection itself that refuses a name resolving to
 * any local address, so the address connected to is the one checked.
 */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
    if (err) return callback(err, []);
    const bad = addresses.find((a) => blockedAddress(a.address));
    if (bad || !addresses.length) {
      const refused = Object.assign(new Error(`${hostname} resolves to ${bad?.address ?? "nothing"}, this machine or its local network, which http.fetch never reaches`), { code: "EKOSREFUSED" });
      return callback(refused, []);
    }
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0]!.address, addresses[0]!.family);
  });
};
