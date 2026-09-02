import { capabilityKey, type ModuleManifest } from "@kos/shared";

import type { ToolDef } from "../models/types.js";
import type { ToolRisk } from "../risk/tiers.js";
import type { ToolHandler, ToolMeta, ToolRegistry } from "../agent/registry.js";
import type { SecretsRegistry } from "../secrets/secrets.js";
import type { Db } from "../store/db.js";
import type { NotifyPayload } from "../tools/notify.js";
import type { Workspace } from "../store/workspace.js";
import type { ProjectManifest } from "../systems/manifest.js";
import type { Migrator } from "../systems/migrate.js";
import type { PageStore } from "../systems/pages.js";
import { satisfies } from "./semver.js";

/**
 * Kernel services a module composes through. Modules never import each other or
 * the kernel internals; they reach the shared workspace, db, secrets, and the
 * notify channel through this bag, handed to them at activation.
 */
export interface ModuleServices {
  workspace: Workspace;
  db: Db;
  secrets: SecretsRegistry;
  /**
   * Say something on the active channel, if one is wired.
   *
   * Takes a payload rather than a string because a message is no longer only
   * text: it may carry a card, buttons, and a destination other than the
   * owner. A surface that cannot render part of it renders what it can.
   */
  notify?: (payload: NotifyPayload) => Promise<void>;
  /** Project manifest (systems/tasks modules). */
  manifest?: ProjectManifest;
  /** Guarded schema migrator. */
  migrator?: Migrator;
  /** Page-spec store for dashboard pages. */
  pages?: PageStore;
}

/**
 * The surfaces a module composes through, handed to it at activation. Modules
 * contribute capabilities here; they never import each other. `services` is
 * present when the host wires it (always, for tool modules); the loader itself
 * stays agnostic so it can drive modules that need no services.
 */
export interface ModuleContext {
  registerTool(
    def: ToolDef,
    handler: ToolHandler,
    risk?: ToolRisk,
    meta?: ToolMeta,
  ): void;
  services?: ModuleServices;
}

/** Assert the host provided kernel services; for modules that require them. */
export function requireServices(ctx: ModuleContext): ModuleServices {
  if (!ctx.services) {
    throw new Error("module requires kernel services but none were provided");
  }
  return ctx.services;
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

/** Build a module context backed by a ToolRegistry, with optional services. */
export function toolRegistryContext(
  registry: ToolRegistry,
  services?: ModuleServices,
): ModuleContext {
  return {
    registerTool: (def, handler, risk, meta) =>
      registry.register(def, handler, risk, meta),
    ...(services ? { services } : {}),
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
