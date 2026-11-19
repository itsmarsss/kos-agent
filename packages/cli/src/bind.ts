import { isIP } from "node:net";
import { networkInterfaces } from "node:os";

/** A name or address only this machine reaches: 127.0.0.0/8, ::1 and localhost. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1") return true;
  const v4 = h.startsWith("::ffff:") ? h.slice("::ffff:".length) : h;
  return isIP(v4) === 4 && v4.startsWith("127.");
}

/** Why the host may not listen where it was asked, or undefined: beyond loopback, every request needs the dashboard token. */
export function bindRefusal(host: string, token: string | undefined): string | undefined {
  if (isLoopbackHost(host) || token) return undefined;
  return `refusing to listen on ${host} without KOS_DASHBOARD_TOKEN: beyond loopback anyone who reaches the port could read the dashboard and change KOS. Set KOS_DASHBOARD_TOKEN in .env, or listen on 127.0.0.1.`;
}

/** Whether a host the CLI is pointed at is this machine: loopback, any-address, or one of its own interfaces. Never a name it would have to resolve. */
export function isLocalHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (isLoopbackHost(h) || h === "0.0.0.0" || h === "::") return true;
  if (isIP(h) === 0) return false;
  return Object.values(networkInterfaces()).some((addrs) => addrs?.some((a) => a.address.toLowerCase() === h));
}

/** Where the CLI dials a host bound to `host`: an any-address is reached on loopback. */
export function dialHost(host: string): string {
  return host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
}
