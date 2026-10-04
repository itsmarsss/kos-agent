import type { KosModule, ModuleContext } from "../modules/loader.js";
import { requireServices } from "../modules/loader.js";
import { MODULE_FILE, MODULES_DIR, readWorkspaceModules, scaffoldModule } from "../modules/workspace.js";
import type { McpStatus } from "./mcp.js";

/**
 * The `modules` tools: what modules the workspace holds, and making a new one.
 *
 * Making one is writing a folder, which is safe: nothing runs until the
 * owner switches the module on in Settings. There is no tool for that on
 * purpose. The agent can build a feature; the owner decides it runs.
 */

export interface ModulesModuleDeps {
  /** Names the owner has switched on, read fresh. */
  enabled: () => string[];
  /** What the MCP module has up right now, by server name. */
  status: () => McpStatus;
}

function str(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== "string" || v.trim() === "") throw new Error(`${key} is required`);
  return v.trim();
}

export function createModulesModule(deps: ModulesModuleDeps): KosModule {
  return {
    manifest: {
      name: "modules",
      version: "1.0.0",
      provides: [
        { kind: "tool", name: "modules.list", version: "1.0.0" },
        { kind: "tool", name: "modules.create", version: "1.0.0" },
      ],
      riskTier: "safe",
    },
    activate(ctx: ModuleContext) {
      const ws = requireServices(ctx).workspace;

      ctx.registerTool(
        {
          name: "modules.list",
          description:
            `Every module in the workspace (a folder under ${MODULES_DIR}/ with a ${MODULE_FILE}): name, description, whether the owner has it on, and the tools it is serving. Also names any that could not be read and why.`,
          inputSchema: { type: "object", properties: {} },
        },
        () => {
          const { modules, invalid } = readWorkspaceModules(ws);
          const on = new Set(deps.enabled());
          const status = deps.status();
          return JSON.stringify({
            modules: modules.map((m) => ({
              ...m.manifest,
              dir: m.dir,
              enabled: on.has(m.manifest.name),
              ...(status[m.manifest.name]
                ? { connected: status[m.manifest.name]!.connected, serving: status[m.manifest.name]!.tools, ...(status[m.manifest.name]!.error ? { error: status[m.manifest.name]!.error } : {}) }
                : {}),
            })),
            invalid,
          });
        },
        { floor: "safe" },
      );

      ctx.registerTool(
        {
          name: "modules.create",
          description:
            "Start a new module: a folder with its manifest and a small server that already speaks the protocol, with one example tool to replace. Edit server.mjs to add tools and module.json to floor them, then ask the owner to switch the module on in Settings; nothing runs before that.",
          inputSchema: {
            type: "object",
            properties: {
              name: { type: "string", description: "lowercase, digits, - and _ only" },
              description: { type: "string", description: "one sentence: what it does" },
            },
            required: ["name", "description"],
          },
        },
        (input) => {
          const made = scaffoldModule(ws, str(input, "name"), str(input, "description"));
          return JSON.stringify({ created: made.dir, files: made.files, next: "edit server.mjs and module.json, then ask the owner to enable it in Settings > Modules" });
        },
        { floor: "safe" },
      );
    },
  };
}
