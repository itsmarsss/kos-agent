import { capabilityKey, type ModuleManifest } from "@kos/shared";

import type { ToolDef } from "../models/types.js";
import type { ToolRisk } from "../risk/tiers.js";
import type { ToolHandler, ToolRegistry } from "../agent/registry.js";
import { satisfies } from "./semver.js";

/**
 * The surfaces a module composes through, handed to it at activation. Modules
 * contribute capabilities here; they never import each other. Starts with tools
 * (the most-used surface); widgets, providers, and channels register the same
 * way as those contracts move behind the module system.
 */
export interface ModuleContext {
  registerTool(def: ToolDef, handler: ToolHandler, risk?: ToolRisk): void;
}

/** A loadable module: its declared manifest plus an activation function. */
export interface KosModule {
  manifest: ModuleManifest;
  activate(ctx: ModuleContext): void | Promise<void>;
}

export interface ModuleFailure {
  name: string;
  reason: string;
}

export interface LoadReport {
  loaded: string[];
  failed: ModuleFailure[];
}

/** Build a module context backed by a ToolRegistry. */
export function toolRegistryContext(registry: ToolRegistry): ModuleContext {
  return {
    registerTool: (def, handler, risk) => registry.register(def, handler, risk),
  };
}

/**
 * The kernel module loader. Resolves declared capability dependencies (with
 * version ranges), activates providers before dependents, and isolates
 * failures: a module that throws, or whose dependencies are unmet (including
 * because a provider itself failed), is disabled and reported, never cascading
 * into a crash.
 */
export class ModuleLoader {
  constructor(private readonly ctx: ModuleContext) {}

  async load(modules: KosModule[]): Promise<LoadReport> {
    const loaded: string[] = [];
    const failed: ModuleFailure[] = [];
    const activated = new Map<string, string>(); // capabilityKey -> version
    const pending = [...modules];

    let progressed = true;
    while (pending.length > 0 && progressed) {
      progressed = false;
      for (let i = 0; i < pending.length; i++) {
        const mod = pending[i]!;
        if (!this.needsMet(mod.manifest, activated)) continue;

        pending.splice(i, 1);
        i--;
        progressed = true;
        try {
          await mod.activate(this.ctx);
          for (const cap of mod.manifest.provides) {
            activated.set(capabilityKey(cap), cap.version);
          }
          loaded.push(mod.manifest.name);
        } catch (err) {
          // Provides are not registered, so dependents stay unmet and disable too.
          failed.push({
            name: mod.manifest.name,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // Anything still pending has unsatisfiable or cyclic dependencies.
    for (const mod of pending) {
      failed.push({
        name: mod.manifest.name,
        reason: "unsatisfied dependencies",
      });
    }

    return { loaded, failed };
  }

  private needsMet(
    manifest: ModuleManifest,
    activated: Map<string, string>,
  ): boolean {
    for (const need of manifest.needs ?? []) {
      const version = activated.get(capabilityKey(need));
      if (version === undefined || !satisfies(version, need.range)) {
        return false;
      }
    }
    return true;
  }
}
