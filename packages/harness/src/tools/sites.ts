import { mkdirSync } from "node:fs";

import type { KosModule, ModuleContext } from "../modules/loader.js";
import { requireServices } from "../modules/loader.js";
import { SAFE } from "../risk/tiers.js";
import { listSites, SITES_DIR, sitesBaseUrl } from "../sites/server.js";
import type { Workspace } from "../store/workspace.js";

/**
 * The `sites` tool module: what the agent has built, and where to look at it.
 *
 * Deliberately thin. A site is a folder of files, and files.write already
 * writes files, so there is no sites.write here: a second way to put bytes on
 * disk would be a second thing to get right. What the agent cannot work out on
 * its own is the convention (sites/<name>/index.html) and the URL its work ends
 * up on, which is the whole job of these two tools.
 */

function slug(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== "string" || !v.trim()) throw new Error(`missing string arg: ${key}`);
  const name = v.trim().replace(/^\/+|\/+$/g, "");
  // The name becomes a path segment and a URL segment. Anything that could
  // make it mean something else in either place is refused by name rather
  // than sanitised into something the caller did not ask for.
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    throw new Error(
      `invalid site name: ${v}. Use letters, digits, dot, dash or underscore, e.g. habit-tracker`,
    );
  }
  return name;
}

function defineSiteTools(ws: Workspace, ctx: ModuleContext): void {
  ctx.registerTool(
    {
      name: "sites.list",
      description:
        "List the web apps in this workspace and the URL each is served at. " +
        "A site is the folder sites/<name>/, and sites/<name>/index.html is " +
        "the page it opens on.",
      inputSchema: { type: "object", properties: {} },
    },
    () => {
      const base = sitesBaseUrl();
      const sites = listSites(ws);
      if (sites.length === 0) {
        return (
          "No sites yet. Create one by writing sites/<name>/index.html with " +
          "files.write, then call sites.list again for its URL."
        );
      }
      return sites
        .map((s) => {
          const url = base ? `${base}/${encodeURIComponent(s.name)}/` : "(not served)";
          return `${s.name} -> ${url}${s.hasIndex ? "" : " (no index.html yet)"}`;
        })
        .join("\n");
    },
    SAFE,
  );

  ctx.registerTool(
    {
      name: "sites.create",
      description:
        "Make an empty site folder and return its URL. Write the pages into " +
        "it with files.write. Use this before building a web app so the name " +
        "and location are right.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
    (input) => {
      const name = slug(input, "name");
      // Through the jail like every other path, so a name that survived the
      // pattern check still cannot land outside sites/.
      mkdirSync(ws.resolve(`${SITES_DIR}/${name}`), { recursive: true });
      const base = sitesBaseUrl();
      return [
        `Created ${SITES_DIR}/${name}/.`,
        `Write ${SITES_DIR}/${name}/index.html to give it a page.`,
        base ? `It will be served at ${base}/${name}/` : "Site serving is off.",
        "The page is served on its own origin and cannot reach the network or the KOS API.",
      ].join("\n");
    },
    SAFE,
  );
}

export const sitesModule: KosModule = {
  manifest: {
    name: "sites",
    version: "1.0.0",
    provides: [
      { kind: "tool", name: "sites.list", version: "1.0.0" },
      { kind: "tool", name: "sites.create", version: "1.0.0" },
    ],
    riskTier: "safe",
  },
  activate(ctx) {
    const { workspace } = requireServices(ctx);
    defineSiteTools(workspace, ctx);
  },
};
