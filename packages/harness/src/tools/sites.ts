import { mkdirSync } from "node:fs";

import type { KosModule, ModuleContext } from "../modules/loader.js";
import { requireServices } from "../modules/loader.js";
import { SAFE } from "../risk/tiers.js";
import { listSites, listSitesFor, sitesDirFor, sitesBaseUrl } from "../sites/server.js";
import type { Workspace } from "../store/workspace.js";

/**
 * The `sites` tool module: what the agent has built, and where to look at it.
 *
 * Deliberately thin. A site is a folder of files, and files.write already
 * writes files, so there is no sites.write here: a second way to put bytes on
 * disk would be a second thing to get right. What the agent cannot work out on
 * its own is the convention and the URL its work ends up on, which is the
 * whole job of these two tools.
 *
 * A site belongs to a project. The tracker, its pages and its data are one
 * thing, so they live in one folder rather than in two places that have to be
 * kept in step.
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
        "A site belongs to a project and lives in " +
        "projects/<project>/sites/<name>/, opening on its index.html.",
      inputSchema: {
        type: "object",
        properties: {
          project: {
            type: "string",
            description: "Only this project's sites. Omit for all of them.",
          },
        },
      },
    },
    (input) => {
      const base = sitesBaseUrl();
      const only = typeof input.project === "string" ? input.project.trim() : "";
      const sites = only ? listSitesFor(ws, only) : listSites(ws);
      if (sites.length === 0) {
        return (
          "No sites yet. Make one with sites.create, giving the project it " +
          "belongs to, then write its index.html with files.write."
        );
      }
      return sites
        .map((s) => {
          const url = base
            ? `${base}/${encodeURIComponent(s.project)}/${encodeURIComponent(s.name)}/`
            : "(not served)";
          return `${s.project}/${s.name} -> ${url}${s.hasIndex ? "" : " (no index.html yet)"}`;
        })
        .join("\n");
    },
    SAFE,
  );

  ctx.registerTool(
    {
      name: "sites.create",
      description:
        "Make an empty site folder inside a project and return its URL. Write " +
        "the pages into it with files.write. Use this before building a web " +
        "app so the name and location are right.",
      inputSchema: {
        type: "object",
        properties: {
          project: {
            type: "string",
            description: "Slug of the project this site belongs to.",
          },
          name: { type: "string" },
        },
        required: ["project", "name"],
      },
    },
    (input) => {
      const project = slug(input, "project");
      const name = slug(input, "name");
      const dir = `${sitesDirFor(project)}/${name}`;
      // Through the jail like every other path, so a name that survived the
      // pattern check still cannot land outside the project.
      mkdirSync(ws.resolve(dir), { recursive: true });
      const base = sitesBaseUrl();
      return [
        `Created ${dir}/.`,
        `Write ${dir}/index.html to give it a page.`,
        base
          ? `It will be served at ${base}/${project}/${name}/`
          : "Site serving is off.",
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
