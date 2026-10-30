import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "@kos/browser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SettingsStore } from "../store/settings.js";
import { Workspace } from "../store/workspace.js";
import { readMcpConfig, upsertMcpServers } from "../tools/mcp.js";
import { BROWSER_KEY, browserConfig, retireBrowserEngine } from "./browsersettings.js";
import { PermissionStore } from "./permissions.js";

/**
 * KOS drives its Chrome itself now. A workspace that ran agent-browser keeps
 * what the owner set and trusted, and loses the server that is no more.
 */
describe("retiring the old browser engine", () => {
  let root: string;
  let ws: Workspace;
  let settings: SettingsStore;
  let permissions: PermissionStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-browser-settings-"));
    ws = Workspace.open(root);
    settings = new SettingsStore(ws.db);
    permissions = new PermissionStore(ws.db);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("moves the settings into KOS's own, takes the server out, and keeps the trusted sites", () => {
    upsertMcpServers(root, {
      browser: {
        command: "npx",
        args: ["-y", "agent-browser@0.39.1", "mcp"],
        env: {
          AGENT_BROWSER_CDP: "9225",
          KOS_BROWSER_VIEWPORT: "1440x900",
          KOS_BROWSER_HEADED: "1",
          KOS_BROWSER_CHROME: "/opt/chrome",
          KOS_BROWSER_EXTENSIONS: "/x/one, /x/two",
          KOS_BROWSER_SEARCH: "https://www.google.com/search?q=%s",
        },
      },
      time: { command: "uvx", args: ["mcp-server-time"] },
    });
    permissions.add({ tool: "mcp.browser.*", scope: "site:shop.example", project: null });
    permissions.add({ tool: "files.write", scope: "dir:notes", project: null });

    expect(retireBrowserEngine(root, settings, ws.db)).toBe("browser");
    expect(browserConfig(settings)).toEqual({
      headed: true,
      chrome: "/opt/chrome",
      extensions: ["/x/one", "/x/two"],
      search: "https://www.google.com/search?q=%s",
      viewport: { width: 1440, height: 900 },
    });
    expect(Object.keys(readMcpConfig(root).servers)).toEqual(["time"]);
    expect(permissions.list().map((r) => `${r.tool} ${r.scope}`)).toEqual(["browser.* site:shop.example", "files.write dir:notes"]);
    // Done once: there is nothing left to retire.
    expect(retireBrowserEngine(root, settings, ws.db)).toBeUndefined();
  });

  it("keeps settings the owner has already made in KOS, and gives the defaults to a workspace that never had the engine", () => {
    expect(retireBrowserEngine(root, settings, ws.db)).toBeUndefined();
    expect(browserConfig(settings)).toEqual(DEFAULT_CONFIG);
    settings.set(BROWSER_KEY, { headed: true });
    upsertMcpServers(root, { browser: { command: "npx", env: { AGENT_BROWSER_CDP: "9225", KOS_BROWSER_HEADED: "0" } } });
    expect(retireBrowserEngine(root, settings, ws.db)).toBe("browser");
    expect(browserConfig(settings).headed).toBe(true);
  });
});
