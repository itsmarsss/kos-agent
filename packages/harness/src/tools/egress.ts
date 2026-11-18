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
  // Forms that carry an IPv4 address inside: IPv4-compatible (::7f00:1), NAT64, 6to4, Teredo.
  ["::", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["2002::", 16],
  ["2001::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
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

/** Loopback, apart from the rest of the local networks: it is opted into port by port. */
const LOOPBACK = new BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");

/**
 * Places on the owner's own network that http.fetch may reach after all,
 * as the owner listed them (KOS_FETCH_LAN, empty by default): a host, an
 * address or a CIDR, each with its port, and `loopback:<port>` for a
 * program on this machine, one port at a time. KOS's own ports are refused
 * whatever the list says.
 */
export interface LanAllow {
  nets: { list: BlockList; port: number }[];
  names: { name: string; port: number }[];
  loopback: Set<number>;
  kos: readonly number[];
}

/** The owner's list, read: "192.168.1.0/24:8123, nas.local:5000, loopback:8080". An entry that does not read is left out. */
export function parseLanAllow(raw: string | undefined, kos: readonly number[] = []): LanAllow {
  const allow: LanAllow = { nets: [], names: [], loopback: new Set(), kos };
  for (const entry of (raw ?? "").split(/[,\s]+/).filter(Boolean)) {
    const m = /^(.+):(\d{1,5})$/.exec(entry.trim());
    if (!m) continue;
    const target = m[1]!.replace(/^\[|\]$/g, "").toLowerCase();
    const port = Number(m[2]);
    if (port < 1 || port > 65_535) continue;
    if (target === "loopback") {
      allow.loopback.add(port);
      continue;
    }
    const [net, bits] = target.split("/");
    const family = isIP(net ?? "");
    if (family) {
      const list = new BlockList();
      const type = family === 4 ? "ipv4" : "ipv6";
      if (bits !== undefined) list.addSubnet(net!, Number(bits), type);
      else list.addAddress(net!, type);
      allow.nets.push({ list, port });
    } else if (/^[a-z0-9.-]+$/.test(target)) {
      allow.names.push({ name: target.replace(/\.$/, ""), port });
    }
  }
  return allow;
}

/** Whether the owner's list lets a fetch reach this local address at this port: never loopback unless opted in, never KOS. */
export function lanAllows(allow: LanAllow | undefined, address: string, port: number, name?: string): boolean {
  if (!allow || allow.kos.includes(port)) return false;
  const plain = unmapped(address.replace(/^\[|\]$/g, ""));
  const family = isIP(plain);
  if (!family) return false;
  const type = family === 4 ? "ipv4" : "ipv6";
  if (LOOPBACK.check(plain, type)) return allow.loopback.has(port);
  if (allow.nets.some((n) => n.port === port && n.list.check(plain, type))) return true;
  return name !== undefined && allow.names.some((n) => n.port === port && n.name === name.toLowerCase());
}

/** A url's host as it is compared: lower case, no brackets, one trailing dot gone. */
function hostOfUrl(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
}

/** A url's port, its scheme's when it names none. */
function portOfUrl(url: URL): number {
  return Number(url.port || (url.protocol === "https:" ? 443 : 80));
}

/**
 * Why a url may not be fetched, before anything is resolved, or undefined:
 * not http(s), a local name, an address literal that is local, or one of
 * KOS's own hosts (`own`, host or host:port as it is reached).
 */
export function refusedUrl(raw: string, own: readonly string[] = [], allow?: LanAllow): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `not a url: ${raw}`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return `${url.protocol} is not fetched; only http and https`;
  const host = hostOfUrl(url);
  const port = portOfUrl(url);
  if (own.some((o) => o.toLowerCase() === host || o.toLowerCase() === `${host}:${port}`)) return `${url.host} is KOS itself, which http.fetch never reaches`;
  if (allow?.kos.includes(port) && (LOCAL_NAMES.test(host) || (isIP(unmapped(host)) !== 0 && blockedAddress(host)))) return `${url.host} is KOS itself, which http.fetch never reaches`;
  // A name on the owner's list goes on to be resolved; the address it resolves to is checked against the list as it connects.
  if (LOCAL_NAMES.test(host) && !allow?.names.some((n) => n.name === host && n.port === port)) return `${url.host} is this machine, which http.fetch never reaches`;
  if (isIP(unmapped(host)) && blockedAddress(host) && !lanAllows(allow, host, port)) return `${url.host} is this machine or its local network, which http.fetch never reaches`;
  return undefined;
}

/** A lookup that refuses any local address, as `lookupFor` with nothing listed. */
export const guardedLookup: LookupFunction = (hostname, options, callback) => lookupFor(80)(hostname, options, callback);

/**
 * A dns lookup for the connection itself, to `port`, that refuses a name
 * resolving to any local address the owner did not list for that port, so
 * the address connected to is the one checked.
 */
export const lookupFor = (port: number, allow?: LanAllow): LookupFunction => (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
    if (err) return callback(err, []);
    const bad = addresses.find((a) => blockedAddress(a.address) && !lanAllows(allow, a.address, port, hostname));
    if (bad || !addresses.length) {
      const refused = Object.assign(new Error(`${hostname} resolves to ${bad?.address ?? "nothing"}, this machine or its local network, which http.fetch never reaches`), { code: "EKOSREFUSED" });
      return callback(refused, []);
    }
      if (options.all) return callback(null, addresses);
    callback(null, addresses[0]!.address, addresses[0]!.family);
  });
};

/**
 * Whether an address a browser step would open is KOS's own dashboard or
 * API on this machine: a local host at one of KOS's ports. KOS's browser
 * may open local pages (a dev server the agent runs), but never KOS
 * itself, whose page holds the key that makes a change.
 */
export function reachesKos(raw: string, ports: readonly number[]): boolean {
  const spelled = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw.trim()) ? raw.trim() : `http://${raw.trim()}`;
  let url: URL;
  try {
    url = new URL(spelled);
  } catch {
    return false;
  }
  const host = hostOfUrl(url);
  const port = portOfUrl(url);
  const local = LOCAL_NAMES.test(host) || (isIP(unmapped(host)) !== 0 && blockedAddress(host));
  return local && ports.includes(port);
}
