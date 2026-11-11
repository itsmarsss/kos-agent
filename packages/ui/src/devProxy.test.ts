import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";

import config from "../vite.config.js";

/** The dev server's proxy, run on a fake request: what Origin reaches the API. */
function proxied(route: string, event: string, headers: Record<string, string>): string | undefined {
  const proxy = new EventEmitter();
  const rule = config.server?.proxy?.[route];
  if (!rule || typeof rule === "string") throw new Error(`no proxy rule for ${route}`);
  rule.configure?.(proxy as never, rule);
  const sent: Record<string, string> = { ...(headers.origin ? { origin: headers.origin } : {}) };
  const proxyReq = { getHeader: (name: string) => sent[name], setHeader: (name: string, value: string) => (sent[name] = value) };
  proxy.emit(event, proxyReq, { headers } as unknown as IncomingMessage);
  return sent.origin;
}

describe("the dev server's proxy", () => {
  const api = new URL(process.env.KOS_API ?? "http://localhost:4317").origin;

  it("passes the dashboard's own page on as the API's origin", () => {
    expect(proxied("/api", "proxyReq", { origin: "http://localhost:5173", "sec-fetch-site": "same-origin" })).toBe(api);
    expect(proxied("/api/socket", "proxyReqWs", { origin: "http://localhost:5173", "sec-fetch-site": "same-origin" })).toBe(api);
  });

  it("leaves another site's origin as it is, so the API still refuses it", () => {
    expect(proxied("/api", "proxyReq", { origin: "https://evil.example", "sec-fetch-site": "cross-site" })).toBe("https://evil.example");
    expect(proxied("/api/socket", "proxyReqWs", { origin: "https://evil.example", "sec-fetch-site": "cross-site" })).toBe("https://evil.example");
  });
});
