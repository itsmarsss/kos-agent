import { parseBrowserConfig, type BrowserConfig } from "@kos/browser";

import type { Db } from "../store/db.js";
import type { SettingsStore } from "../store/settings.js";
import { mcpToolName, readMcpConfig, removeMcpServer } from "../tools/mcp.js";

/** Where Settings > Browser is kept. */
export const BROWSER_KEY = "browser";
/** The DevTools port of KOS's Chrome: fixed, so a Chrome left running is found again on it. */
export const BROWSER_PORT = 9225;

export function browserConfig(settings: SettingsStore): BrowserConfig {
  return parseBrowserConfig(settings.get(BROWSER_KEY));
}

/**
 * The old engine retired.
 *
 * agent-browser ran as an MCP server, and KOS kept the browser's settings
 * as its own keys in that server's entry in mcp.json. KOS drives the browser
 * itself now, so those settings move into KOS's own, the entry goes (or its
 * raw tools would still be offered, and npx would still start it at every
 * boot), and the sites the owner trusted it on stay trusted, for KOS's
 * browser tools. Once done there is no such entry, so it runs once. Returns
 * the retired server's name.
 */
export function retireBrowserEngine(workspaceRoot: string, settings: SettingsStore, db: Db): string | undefined {
  const found = Object.entries(readMcpConfig(workspaceRoot).servers).find(([, s]) => s.env?.["AGENT_BROWSER_CDP"]);
  if (!found) return undefined;
  const [name, server] = found;
  const env = server.env ?? {};
  if (settings.get(BROWSER_KEY) === undefined) {
    const size = /^(\d{3,5})x(\d{3,5})$/.exec(env["KOS_BROWSER_VIEWPORT"] ?? "");
    settings.set(
      BROWSER_KEY,
      parseBrowserConfig({
        headed: /^(1|true|yes|on)$/i.test(env["KOS_BROWSER_HEADED"] ?? ""),
        chrome: env["KOS_BROWSER_CHROME"],
        extensions: (env["KOS_BROWSER_EXTENSIONS"] ?? "").split(/[\n,]/),
        search: env["KOS_BROWSER_SEARCH"],
        ...(size ? { viewport: { width: Number(size[1]), height: Number(size[2]) } } : {}),
      }),
    );
  }
  db.prepare(`UPDATE permission_rules SET tool = 'browser.*' WHERE tool = ?`).run(`${mcpToolName(name, "")}*`);
  removeMcpServer(workspaceRoot, name);
  return name;
}
