import { describe, expect, it } from "vitest";

import {
  MCP_PICKS,
  listGithubSkills,
  listingFromRegistry,
  mcpConfigFor,
  mcpNameFor,
  parseGithubTree,
  parseSourceShorthand,
  pickConfig,
  searchRegistry,
  type Fetch,
} from "./catalog.js";

/** A fetch that answers from a table of URLs. */
function fetchOf(table: Record<string, unknown>): Fetch {
  return async (url) => {
    const hit = Object.entries(table).find(([k]) => url.startsWith(k));
    const body = hit?.[1];
    return {
      ok: body !== undefined,
      status: body === undefined ? 404 : 200,
      json: async () => body,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    };
  };
}

describe("reading where a skill comes from", () => {
  it("takes a folder inside a repository apart, and leaves a whole repository alone", () => {
    expect(parseGithubTree("https://github.com/anthropics/skills/tree/main/skills/pdf")).toEqual({
      owner: "anthropics", repo: "skills", ref: "main", path: "skills/pdf",
    });
    expect(parseGithubTree("https://github.com/anthropics/skills/tree/main/skills/pdf/")?.path).toBe("skills/pdf");
    expect(parseGithubTree("https://github.com/x/kos-notes.git")).toBeUndefined();
    expect(parseGithubTree("https://github.com/x/y/tree/main/../etc")).toBeUndefined();
  });

  it("reads owner/repo and owner/repo/path as typed", () => {
    expect(parseSourceShorthand("anthropics/skills")).toEqual({ repo: "anthropics/skills", path: "" });
    expect(parseSourceShorthand("anthropics/skills/skills/")).toEqual({ repo: "anthropics/skills", path: "skills" });
    expect(parseSourceShorthand("not a repo")).toBeUndefined();
    expect(parseSourceShorthand("a/b/../c")).toBeUndefined();
  });
});

describe("listing a repository's skills", () => {
  it("names each folder with a SKILL.md from its front matter, on the default branch", async () => {
    const fetchFn = fetchOf({
      "https://api.github.com/repos/o/r/contents/skills": [
        { name: "pdf", type: "dir" },
        { name: "notes.md", type: "file" },
        { name: "empty", type: "dir" },
      ],
      "https://api.github.com/repos/o/r": { default_branch: "trunk" },
      "https://raw.githubusercontent.com/o/r/trunk/skills/pdf/SKILL.md": "---\nname: pdf\ndescription: Read PDFs.\n---\n",
    });
    const skills = await listGithubSkills("o/r", "skills", fetchFn);
    expect(skills).toEqual([
      { name: "pdf", description: "Read PDFs.", source: "https://github.com/o/r/tree/trunk/skills/pdf", repo: "o/r" },
    ]);
  });

  it("says when GitHub refuses", async () => {
    await expect(listGithubSkills("o/missing", "", fetchOf({}))).rejects.toThrow(/GitHub says 404/);
  });
});

describe("the MCP registry", () => {
  const entry = {
    name: "io.github.acme/weather",
    description: "Weather by city.",
    version: "1.2.0",
    repository: { url: "https://github.com/acme/weather", source: "github" },
    packages: [
      {
        registryType: "npm",
        identifier: "@acme/weather-mcp",
        version: "1.2.0",
        runtimeHint: "npx",
        transport: { type: "stdio" },
        environmentVariables: [{ name: "WEATHER_KEY", description: "API key", isRequired: true, isSecret: true }],
      },
    ],
    remotes: [{ type: "streamable-http", url: "https://weather.example/mcp", headers: [{ name: "Authorization", isRequired: true, isSecret: true }] }],
    _meta: { "io.modelcontextprotocol.registry/official": { isLatest: true } },
  };

  it("trims an entry to what installing needs", () => {
    expect(listingFromRegistry(entry)).toEqual({
      name: "io.github.acme/weather",
      title: "weather",
      description: "Weather by city.",
      version: "1.2.0",
      repository: "https://github.com/acme/weather",
      packages: [{ registry: "npm", identifier: "@acme/weather-mcp", version: "1.2.0", runtime: "npx", env: [{ name: "WEATHER_KEY", description: "API key", required: true, secret: true }] }],
      remotes: [{ type: "streamable-http", url: "https://weather.example/mcp", headers: [{ name: "Authorization", description: "", required: true, secret: true }] }],
    });
    expect(listingFromRegistry({ nope: 1 })).toBeUndefined();
  });

  it("keeps the latest version of each server and drops one with nothing to install", async () => {
    // The registry wraps each server with what it knows about it.
    const { _meta, ...server } = entry;
    const latest = { server, _meta };
    const old = { server: { ...server, version: "1.0.0" }, _meta: { "io.modelcontextprotocol.registry/official": { isLatest: false } } };
    const bare = { server: { name: "x/bare", description: "", version: "1", packages: [], remotes: [] }, _meta };
    const fetchFn = fetchOf({ "https://registry.modelcontextprotocol.io/v0/servers?limit=30&search=weather": { servers: [old, latest, bare, latest, entry] } });
    const results = await searchRegistry("weather", fetchFn);
    expect(results.map((r) => `${r.name}@${r.version}`)).toEqual(["io.github.acme/weather@1.2.0"]);
  });

  it("writes an mcp.json entry for a package, a remote, and the other registries", () => {
    const listing = listingFromRegistry(entry)!;
    expect(mcpConfigFor(listing, { package: 0 }, { WEATHER_KEY: "k1" })).toEqual({
      command: "npx", args: ["-y", "@acme/weather-mcp@1.2.0"], env: { WEATHER_KEY: "k1" },
    });
    expect(mcpConfigFor(listing, { remote: 0 }, { Authorization: "Bearer t" })).toEqual({
      url: "https://weather.example/mcp", headers: { Authorization: "Bearer t" },
    });
    // Blank answers are not sent along as empty strings.
    expect(mcpConfigFor(listing, { package: 0 }, { WEATHER_KEY: " " })).toEqual({ command: "npx", args: ["-y", "@acme/weather-mcp@1.2.0"] });
    const py = { ...listing, packages: [{ registry: "pypi", identifier: "mcp-server-x", version: "0.3", env: [] }] };
    expect(mcpConfigFor(py, { package: 0 })).toEqual({ command: "uvx", args: ["mcp-server-x==0.3"] });
    const oci = { ...listing, packages: [{ registry: "oci", identifier: "acme/x:latest", env: [{ name: "K", description: "", required: true, secret: false }] }] };
    expect(mcpConfigFor(oci, { package: 0 }, { K: "v" })).toEqual({ command: "docker", args: ["run", "-i", "--rm", "-e", "K", "acme/x:latest"], env: { K: "v" } });
    expect(() => mcpConfigFor(listing, { package: 4 })).toThrow(/no such package/);
  });

  it("names a server plainly from its registry name", () => {
    expect(mcpNameFor("io.github.acme/Weather MCP")).toBe("weather-mcp");
    expect(mcpNameFor("///")).toBe("server");
  });

  it("fills the workspace into a reference server's arguments", () => {
    const fs = MCP_PICKS.find((p) => p.name === "filesystem")!;
    expect(pickConfig(fs, "/home/me/kos").args).toEqual(["-y", "@modelcontextprotocol/server-filesystem", "/home/me/kos"]);
    const fetch = MCP_PICKS.find((p) => p.name === "fetch")!;
    expect(pickConfig(fetch, "/x")).toEqual({ command: "uvx", args: ["mcp-server-fetch"], risk: "safe" });
  });
});
