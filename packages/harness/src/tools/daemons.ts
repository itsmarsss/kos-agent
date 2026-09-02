import { existsSync } from "node:fs";

import { resolvePath } from "../jail/resolvePath.js";
import type { DaemonStore } from "../daemons/store.js";
import type { DaemonSupervisor } from "../daemons/supervisor.js";
import type { Daemon, DaemonRuntime } from "../daemons/types.js";
import type { KosModule, ModuleContext } from "../modules/loader.js";
import { requireServices } from "../modules/loader.js";

/**
 * The `daemons` tool module: programs that keep running.
 *
 * Sites are files KOS serves. This is the other half of "build me an app": a
 * process that stays up, so a tracker can have an API behind it, a worker can
 * watch a folder, and something the agent wrote at 3am is still answering at
 * noon.
 *
 * Registering one runs code that KOS did not write and nobody read, on a
 * schedule of its own, until it is stopped. That is the definition of risky,
 * so create and start ask the owner first. Listing, reading logs and stopping
 * do not: none of them starts anything, and stopping something that is
 * misbehaving should never be the thing that waits for approval.
 */

/** The band daemons are given ports from, above the dashboard's own. */
export const PORT_RANGE = { first: 4400, last: 4499 };

export interface DaemonToolDeps {
  store: DaemonStore;
  supervisor: DaemonSupervisor;
  workspaceRoot: string;
  /** Where a daemon can be reached through the dashboard, for the reply. */
  urlFor?: (daemon: Daemon) => string | null;
}

function str(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`missing string arg: ${key}`);
  }
  return value.trim();
}

/**
 * A name that is also a path segment and a URL segment. Refused rather than
 * sanitised: a name quietly turned into something else is a daemon the agent
 * cannot find again.
 */
export function daemonName(raw: string): string {
  const name = raw.trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    throw new Error(
      `invalid name: ${raw}. Use letters, digits, dot, dash or underscore, e.g. api`,
    );
  }
  return name;
}

/** The lowest free port in the band, or nothing left to give. */
export function nextPort(taken: ReadonlySet<number>): number {
  for (let port = PORT_RANGE.first; port <= PORT_RANGE.last; port++) {
    if (!taken.has(port)) return port;
  }
  throw new Error(
    `no ports left: ${PORT_RANGE.first}-${PORT_RANGE.last} are all taken. Delete a daemon first.`,
  );
}

function describe(
  daemon: Daemon,
  deps: DaemonToolDeps,
): Record<string, unknown> {
  const status = deps.supervisor.statusOf(daemon.id);
  return {
    id: daemon.id,
    project: daemon.project,
    name: daemon.name,
    runtime: daemon.runtime,
    entry: daemon.entry,
    port: daemon.port,
    enabled: daemon.enabled,
    state: status.state,
    ...(status.since ? { upSince: status.since } : {}),
    ...(status.restarts ? { restarts: status.restarts } : {}),
    ...(status.lastError ? { lastError: status.lastError } : {}),
    ...(deps.urlFor?.(daemon) ? { url: deps.urlFor(daemon) } : {}),
  };
}

function define(deps: DaemonToolDeps, ctx: ModuleContext): void {
  const { store, supervisor } = deps;

  const required = (id: number): Daemon => {
    const daemon = store.get(id);
    if (!daemon) throw new Error(`no such daemon: ${id}`);
    return daemon;
  };

  ctx.registerTool(
    {
      name: "daemons.list",
      description:
        "The long-running programs in this workspace: what each is, whether it is up, " +
        "and the URL it is reachable at.",
      inputSchema: { type: "object", properties: {} },
    },
    () => JSON.stringify(store.list().map((d) => describe(d, deps))),
    { floor: "safe" },
    { tags: ["daemons"] },
  );

  ctx.registerTool(
    {
      name: "daemons.logs",
      description:
        "What a daemon has printed lately. The first place to look when one is not " +
        "doing what it should.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "number" }, lines: { type: "number" } },
        required: ["id"],
      },
    },
    (input) => {
      const id = Number(input.id);
      required(id);
      const lines = typeof input.lines === "number" ? input.lines : 100;
      const tail = supervisor.logs(id, lines);
      return tail.length ? tail.join("\n") : "(nothing logged yet)";
    },
    { floor: "safe" },
    { tags: ["daemons"] },
  );

  ctx.registerTool(
    {
      name: "daemons.create",
      description:
        "Register a program to keep running. The entry is a file in this workspace, " +
        "node or python. It is given PORT and HOST=127.0.0.1 in its environment and " +
        "should listen on those; it is reached through KOS rather than being on the " +
        "network itself. It gets no API keys: anything it needs, write into its own " +
        "project. Write the file first, then register it.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          name: { type: "string" },
          runtime: { type: "string", description: "node or python" },
          entry: { type: "string", description: "workspace-relative path to the program" },
          args: { type: "array", items: { type: "string" } },
          listens: {
            type: "boolean",
            description: "true (default) for a server; false for a worker with no port",
          },
        },
        required: ["project", "name", "entry"],
      },
    },
    (input) => {
      const project = daemonName(str(input, "project"));
      const name = daemonName(str(input, "name"));
      const entry = str(input, "entry");
      const runtime: DaemonRuntime = input.runtime === "python" ? "python" : "node";

      if (store.find(project, name)) {
        throw new Error(
          `${project}/${name} already exists. Delete it or pick another name.`,
        );
      }
      // Checked now rather than at spawn: an entry that is not there is a typo
      // the caller can fix, and finding out through a crash loop is worse.
      const abs = resolvePath(deps.workspaceRoot, entry);
      if (!existsSync(abs)) {
        throw new Error(`no such file: ${entry}. Write the program before registering it.`);
      }

      const listens = input.listens !== false;
      const daemon = store.create({
        project,
        name,
        runtime,
        entry,
        args: Array.isArray(input.args)
          ? input.args.filter((a): a is string => typeof a === "string")
          : [],
        port: listens ? nextPort(store.takenPorts()) : null,
      });
      supervisor.start(daemon);
      return JSON.stringify(describe(daemon, deps));
    },
    // Registering one starts it, and it keeps running after the turn ends.
    { floor: "risky" },
    { tags: ["daemons"] },
  );

  ctx.registerTool(
    {
      name: "daemons.start",
      description: "Start a daemon that is stopped, or restart one that has crashed.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "number" } },
        required: ["id"],
      },
    },
    (input) => {
      const daemon = required(Number(input.id));
      store.setEnabled(daemon.id, true);
      supervisor.start({ ...daemon, enabled: true });
      return JSON.stringify(describe(required(daemon.id), deps));
    },
    { floor: "risky" },
    { tags: ["daemons"] },
  );

  ctx.registerTool(
    {
      name: "daemons.stop",
      description:
        "Stop a daemon and leave it stopped. Safe: stopping something that is " +
        "misbehaving should not have to wait for anyone.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "number" } },
        required: ["id"],
      },
    },
    async (input) => {
      const daemon = required(Number(input.id));
      store.setEnabled(daemon.id, false);
      await supervisor.stop(daemon.id);
      return JSON.stringify(describe(required(daemon.id), deps));
    },
    { floor: "safe" },
    { tags: ["daemons"] },
  );

  ctx.registerTool(
    {
      name: "daemons.remove",
      description:
        "Stop a daemon and forget it. The program itself stays on disk; this is the " +
        "registration, not the code.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "number" } },
        required: ["id"],
      },
    },
    async (input) => {
      const daemon = required(Number(input.id));
      await supervisor.stop(daemon.id);
      store.remove(daemon.id);
      return `removed ${daemon.project}/${daemon.name}`;
    },
    { floor: "risky" },
    { tags: ["daemons"] },
  );
}

export function createDaemonsModule(deps: DaemonToolDeps): KosModule {
  return {
    manifest: {
      name: "daemons",
      version: "1.0.0",
      provides: [
        { kind: "tool", name: "daemons.list", version: "1.0.0" },
        { kind: "tool", name: "daemons.logs", version: "1.0.0" },
        { kind: "tool", name: "daemons.create", version: "1.0.0" },
        { kind: "tool", name: "daemons.start", version: "1.0.0" },
        { kind: "tool", name: "daemons.stop", version: "1.0.0" },
        { kind: "tool", name: "daemons.remove", version: "1.0.0" },
      ],
      riskTier: "risky",
    },
    activate(ctx) {
      requireServices(ctx);
      define(deps, ctx);
    },
  };
}
