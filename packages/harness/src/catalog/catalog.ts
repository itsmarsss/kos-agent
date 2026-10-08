import { manifestFromSkillMd } from "../skills/install.js";
import type { McpServerConfig } from "../tools/mcp.js";

export { parseGithubTree, parseSourceShorthand, type GithubTree } from "./github.js";

/**
 * Where to find skills and MCP servers without leaving the app.
 *
 * Skills come from repositories in Claude Code's shape, a folder per skill
 * with a SKILL.md in it; Anthropic's own collection is the first source and
 * the owner can point at any other `owner/repo/path`. MCP servers come from
 * the official registry, which carries each server's npm or pypi package,
 * the environment it needs and any remote endpoint, enough to write the
 * mcp.json entry for it. A short list of the reference servers is kept here
 * as well, because the registry's search ranks a hundred forks above them.
 *
 * Nothing here installs anything: it describes what exists, in a shape the
 * existing install paths accept.
 */

/** One place skills are listed from: a path inside a GitHub repository. */
export interface SkillSource {
  /** `owner/repo`. */
  repo: string;
  /** Path inside it that holds one folder per skill. */
  path: string;
  label: string;
  blurb: string;
}

export const SKILL_SOURCES: SkillSource[] = [
  {
    repo: "anthropics/skills",
    path: "skills",
    label: "Anthropic",
    blurb: "Anthropic's own Agent Skills: documents, spreadsheets, PDFs, slides, design, testing, and a skill for writing skills.",
  },
];

export interface SkillListing {
  name: string;
  description: string;
  /** What to give the installer: a GitHub tree URL to the skill's folder. */
  source: string;
  repo: string;
}

export type Fetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

const GITHUB_HEADERS = { Accept: "application/vnd.github+json", "User-Agent": "kos" };

/**
 * The skills a repository folder holds: each subfolder with a SKILL.md,
 * named and described from that file's front matter.
 */
export async function listGithubSkills(repo: string, path: string, fetchFn: Fetch): Promise<SkillListing[]> {
  const meta = await fetchFn(`https://api.github.com/repos/${repo}`, { headers: GITHUB_HEADERS });
  if (!meta.ok) throw new Error(`GitHub says ${meta.status} for ${repo}`);
  const branch = String(((await meta.json()) as { default_branch?: string }).default_branch ?? "main");
  const dir = path ? `/${path}` : "";
  const listing = await fetchFn(`https://api.github.com/repos/${repo}/contents${dir}`, { headers: GITHUB_HEADERS });
  if (!listing.ok) throw new Error(`GitHub says ${listing.status} for ${repo}${dir}`);
  const entries = (await listing.json()) as { name?: string; type?: string }[];
  const folders = (Array.isArray(entries) ? entries : []).filter((e) => e.type === "dir" && typeof e.name === "string");
  const out: SkillListing[] = [];
  // A few at a time: twenty folders is twenty files to read, and all at once
  // is how an unauthenticated client gets rate limited.
  for (let i = 0; i < folders.length; i += 6) {
    const batch = await Promise.all(
      folders.slice(i, i + 6).map(async (f) => {
        const name = f.name!;
        const file = await fetchFn(
          `https://raw.githubusercontent.com/${repo}/${branch}${dir}/${name}/SKILL.md`,
          { headers: { "User-Agent": "kos" } },
        );
        if (!file.ok) return undefined;
        const manifest = manifestFromSkillMd(await file.text(), name);
        return {
          name: manifest.name,
          description: manifest.description,
          source: `https://github.com/${repo}/tree/${branch}${dir}/${name}`,
          repo,
        } satisfies SkillListing;
      }),
    );
    out.push(...batch.filter((s): s is SkillListing => s !== undefined));
  }
  return out;
}

/** What the registry says about a server, trimmed to what installing needs. */
export interface McpListing {
  name: string;
  title: string;
  description: string;
  version: string;
  repository?: string;
  packages: McpPackage[];
  remotes: McpRemote[];
}

export interface McpEnvVar {
  name: string;
  description: string;
  required: boolean;
  secret: boolean;
}

export interface McpPackage {
  registry: "npm" | "pypi" | "oci" | string;
  identifier: string;
  version?: string;
  runtime?: string;
  env: McpEnvVar[];
}

export interface McpRemote {
  type: string;
  url: string;
  headers: McpEnvVar[];
}

const REGISTRY = "https://registry.modelcontextprotocol.io/v0/servers";

function envOf(raw: unknown): McpEnvVar[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((v) => {
    if (typeof v !== "object" || v === null) return [];
    const e = v as Record<string, unknown>;
    if (typeof e["name"] !== "string") return [];
    return [
      {
        name: e["name"],
        description: typeof e["description"] === "string" ? e["description"] : "",
        required: e["isRequired"] === true,
        secret: e["isSecret"] === true,
      },
    ];
  });
}

/** One registry entry, or nothing if it is not one. */
export function listingFromRegistry(raw: unknown): McpListing | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r["name"] !== "string") return undefined;
  const packages = Array.isArray(r["packages"])
    ? r["packages"].flatMap((p) => {
        if (typeof p !== "object" || p === null) return [];
        const pk = p as Record<string, unknown>;
        if (typeof pk["identifier"] !== "string") return [];
        return [
          {
            registry: typeof pk["registryType"] === "string" ? pk["registryType"] : "npm",
            identifier: pk["identifier"],
            ...(typeof pk["version"] === "string" ? { version: pk["version"] } : {}),
            ...(typeof pk["runtimeHint"] === "string" ? { runtime: pk["runtimeHint"] } : {}),
            env: envOf(pk["environmentVariables"]),
          } satisfies McpPackage,
        ];
      })
    : [];
  const remotes = Array.isArray(r["remotes"])
    ? r["remotes"].flatMap((m) => {
        if (typeof m !== "object" || m === null) return [];
        const rm = m as Record<string, unknown>;
        if (typeof rm["url"] !== "string") return [];
        return [{ type: typeof rm["type"] === "string" ? rm["type"] : "streamable-http", url: rm["url"], headers: envOf(rm["headers"]) }];
      })
    : [];
  const repository = typeof r["repository"] === "object" && r["repository"] !== null ? (r["repository"] as { url?: unknown }).url : undefined;
  return {
    name: r["name"],
    title: typeof r["title"] === "string" && r["title"] ? r["title"] : r["name"].split("/").pop() ?? r["name"],
    description: typeof r["description"] === "string" ? r["description"] : "",
    version: typeof r["version"] === "string" ? r["version"] : "",
    ...(typeof repository === "string" ? { repository } : {}),
    packages,
    remotes,
  };
}

/**
 * Search the registry. The registry lists every version of a server, so
 * only the one it marks latest is kept, and a server with nothing to install
 * from (no package, no remote) is left out.
 */
export async function searchRegistry(query: string, fetchFn: Fetch, limit = 30): Promise<McpListing[]> {
  const url = `${REGISTRY}?limit=${limit}${query.trim() ? `&search=${encodeURIComponent(query.trim())}` : ""}`;
  const res = await fetchFn(url, { headers: { "User-Agent": "kos" } });
  if (!res.ok) throw new Error(`the MCP registry says ${res.status}`);
  const body = (await res.json()) as { servers?: unknown };
  const rows = Array.isArray(body.servers) ? body.servers : [];
  const seen = new Set<string>();
  const out: McpListing[] = [];
  for (const row of rows) {
    // Each row is { server, _meta }: the server as published, and what the
    // registry knows about it. Older responses put the fields at the top.
    const wrapped = row as { server?: unknown; _meta?: Record<string, { isLatest?: boolean }> };
    const meta = wrapped._meta?.["io.modelcontextprotocol.registry/official"];
    if (meta && meta.isLatest === false) continue;
    const listing = listingFromRegistry(wrapped.server ?? row);
    if (!listing || seen.has(listing.name)) continue;
    if (listing.packages.length === 0 && listing.remotes.length === 0) continue;
    seen.add(listing.name);
    out.push(listing);
  }
  return out;
}

/** A name for mcp.json from a registry name: the last segment, plainly. */
export function mcpNameFor(registryName: string): string {
  const last = registryName.split("/").pop() ?? registryName;
  return last.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "server";
}

/**
 * The mcp.json entry for a listing. A package runs over stdio with the
 * runtime its registry implies; a remote is reached by URL. The owner's
 * answers for the variables it asks for ride along as env or headers.
 */
export function mcpConfigFor(
  listing: McpListing,
  choice: { package?: number; remote?: number },
  values: Record<string, string> = {},
): McpServerConfig {
  const filled = (vars: McpEnvVar[]): Record<string, string> =>
    Object.fromEntries(vars.filter((v) => values[v.name]?.trim()).map((v) => [v.name, values[v.name]!.trim()]));
  if (choice.remote !== undefined) {
    const remote = listing.remotes[choice.remote];
    if (!remote) throw new Error("no such remote");
    const headers = filled(remote.headers);
    return { url: remote.url, ...(Object.keys(headers).length ? { headers } : {}) };
  }
  const pkg = listing.packages[choice.package ?? 0];
  if (!pkg) throw new Error("no such package");
  const env = filled(pkg.env);
  const withEnv = Object.keys(env).length ? { env } : {};
  const pinned = pkg.version ? `${pkg.identifier}@${pkg.version}` : pkg.identifier;
  switch (pkg.registry) {
    case "pypi":
      return { command: "uvx", args: [pinned.replace("@", "==")], ...withEnv };
    case "oci":
      return {
        command: "docker",
        args: ["run", "-i", "--rm", ...Object.keys(env).flatMap((k) => ["-e", k]), pkg.identifier],
        ...withEnv,
      };
    default:
      return { command: pkg.runtime === "npx" || !pkg.runtime ? "npx" : pkg.runtime, args: ["-y", pinned], ...withEnv };
  }
}

/** A reference server, ready to add. `{workspace}` in an argument is the workspace root. */
export interface McpPick {
  name: string;
  blurb: string;
  needs: "node" | "uv" | "docker";
  server: McpServerConfig;
  /** Why a floor other than risky is right, when it is. */
  risk?: "safe";
}

/**
 * The reference servers from modelcontextprotocol/servers and the one
 * browser everyone reaches for. Pinned to the command each project
 * documents, since the registry lists a hundred forks ahead of them.
 */
export const MCP_PICKS: McpPick[] = [
  {
    name: "filesystem",
    blurb: "Read, write and search files under the workspace, with every path checked against it.",
    needs: "node",
    server: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "{workspace}"] },
  },
  {
    name: "fetch",
    blurb: "Fetch a web page and hand it over as markdown.",
    needs: "uv",
    server: { command: "uvx", args: ["mcp-server-fetch"] },
    risk: "safe",
  },
  {
    name: "memory",
    blurb: "A knowledge graph the model can add to and query across turns.",
    needs: "node",
    server: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] },
    risk: "safe",
  },
  {
    name: "sequential-thinking",
    blurb: "Step-by-step reasoning as a tool, for problems that need working through.",
    needs: "node",
    server: { command: "npx", args: ["-y", "@modelcontextprotocol/server-sequential-thinking"] },
    risk: "safe",
  },
  {
    name: "git",
    blurb: "Read and search git repositories: log, diff, blame, status.",
    needs: "uv",
    server: { command: "uvx", args: ["mcp-server-git"] },
  },
  {
    name: "time",
    blurb: "The time now, in any timezone, and conversions between them.",
    needs: "uv",
    server: { command: "uvx", args: ["mcp-server-time"] },
    risk: "safe",
  },
  {
    name: "playwright",
    blurb: "A real browser: open pages, click, type, read what is on screen.",
    needs: "node",
    server: { command: "npx", args: ["@playwright/mcp@latest"] },
  },
];

/** A pick's config with the workspace root filled in. */
export function pickConfig(pick: McpPick, workspaceRoot: string): McpServerConfig {
  return {
    ...pick.server,
    ...(pick.server.args ? { args: pick.server.args.map((a) => a.replace("{workspace}", workspaceRoot)) } : {}),
    ...(pick.risk ? { risk: pick.risk } : {}),
  };
}
