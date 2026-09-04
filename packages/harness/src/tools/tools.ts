import type { ToolRegistry } from "../agent/registry.js";
import type { KosModule } from "../modules/loader.js";
import { requireServices } from "../modules/loader.js";

/**
 * The `tools.list` tool: what KOS can do, asked for rather than assumed.
 *
 * The tool list in front of the agent is not the whole toolkit. Once the
 * registry outgrows the per-turn cap the offered set is narrowed by what the
 * message appears to be about, so capabilities appear and vanish between
 * turns, and a tool that was there a moment ago is simply absent with nothing
 * said about it. An agent cannot tell that from not having the capability at
 * all, so it works with what it can see and reports the job done by other
 * means -- which is how a turn ends with a memory entry claiming a change was
 * made that was not.
 *
 * Withheld is not forbidden: the narrowing decides what is offered, and the
 * allow-list decides what may run. So knowing a name is enough to use it,
 * which is what makes this worth a tool rather than a note.
 *
 * Untagged on purpose, so it is the one thing that never gets narrowed away.
 */

export interface ToolsToolDeps {
  /** The live registry, so the answer reflects modules loaded since boot. */
  registry: () => ToolRegistry;
  /** What this conversation may run, when the owner has narrowed it. */
  allow?: () => string[] | undefined;
}

/** Everything registered, grouped by the module that provides it. */
export function describeTools(
  registry: ToolRegistry,
  allow?: string[],
): string {
  const groups = new Map<string, string[]>();
  const listed = registry.defs();
  for (const def of listed) {
    const family = def.name.includes(".") ? def.name.split(".")[0]! : def.name;
    const reachable =
      allow === undefined ||
      allow.some((p) => def.name === p || def.name.startsWith(`${p}.`));
    const line = `${def.name}${reachable ? "" : " (not in this conversation)"} — ${
      (def.description ?? "").split("\n")[0]!.slice(0, 140)
    }`;
    groups.set(family, [...(groups.get(family) ?? []), line]);
  }

  const body = [...groups.entries()]
    .map(([family, lines]) => `## ${family}\n${lines.join("\n")}`)
    .join("\n\n");

  /*
   * Restricted tools are counted but not named. They exist and are real, and
   * an agent that cannot reach them does not need their names -- but a count
   * that quietly omitted them would be the same silent absence this tool was
   * written to fix.
   */
  const held = registry.size - listed.length;

  return [
    `${listed.length} tools you can name${
      held ? `, and ${held} more that only certain conversations are granted` : ""
    }.`,
    "The list you were given this turn may be shorter: it is narrowed by what",
    "the message looks like it is about. A tool missing from it is still",
    "callable by name, so use one from here if you need it.",
    "",
    body,
  ].join("\n");
}

export function createToolsModule(deps: ToolsToolDeps): KosModule {
  return {
    manifest: {
      name: "tools",
      version: "1.0.0",
      provides: [{ kind: "tool", name: "tools.list", version: "1.0.0" }],
      riskTier: "safe",
    },
    activate(ctx) {
      requireServices(ctx);
      ctx.registerTool(
        {
          name: "tools.list",
          description:
            "Everything KOS can do, whether or not it was offered this turn. Ask when " +
            "you are not sure a capability exists, before saying something cannot be " +
            "done, or after being told the toolkit has changed. A tool named here can " +
            "be called even if it is absent from your current list.",
          inputSchema: { type: "object", properties: {} },
        },
        () => describeTools(deps.registry(), deps.allow?.()),
        { floor: "safe" },
      );
    },
  };
}
