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
import type { CronStore } from "../cron/store.js";
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
  notify?: (payload: NotifyPayload) => Promise<string | undefined>;
  /** Project manifest (systems/tasks modules). */
  manifest?: ProjectManifest;
  /** Guarded schema migrator. */
  migrator?: Migrator;
  /** Page-spec store for dashboard pages. */
  pages?: PageStore;
  /** Scheduled jobs, so a blueprint can carry a project's. */
  crons?: CronStore;
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
  /** Take a tool back, for a module whose server the owner switched off. */
  unregisterTool?(name: string): boolean;
  services?: ModuleServices;
}

/** Assert the host provided kernel services; for modules that require them. */
export function requireServices(ctx: ModuleContext): ModuleServices {
  if (!ctx.services) {
    throw new Error("module requires kernel services but none were provided");
  }
  return ctx.services;
}

/**
 * A loadable module: its declared manifest, an activation function, and
 * for one that holds something open, a way to let it go.
 *
 * Deactivate is for child processes, sockets and timers a module started:
 * an MCP server is a process that must not outlive the host. Tools need
 * no unregistering; the registry goes with the kernel.
 */
export interface KosModule {
  manifest: ModuleManifest;
  activate(ctx: ModuleContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
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
    unregisterTool: (name) => registry.unregister(name),
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
  /** What activated, in the order it did, so it can be let go in reverse. */
  private readonly active: KosModule[] = [];
  /** Every module handed to load, by name, so one switched off can be switched back on. */
  private readonly known = new Map<string, KosModule>();
  /** The tools each module registered, so they can be taken back. */
  private readonly tools = new Map<string, string[]>();

  constructor(private readonly ctx: ModuleContext) {}

  /** A context that remembers what the module registered under its name. */
  private contextFor(name: string): ModuleContext {
    const registered = this.tools.get(name) ?? [];
    this.tools.set(name, registered);
    return {
      ...this.ctx,
      registerTool: (def, handler, risk, meta) => {
        this.ctx.registerTool(def, handler, risk, meta);
        registered.push(def.name);
      },
    };
  }

  async load(modules: KosModule[], options: { skip?: Iterable<string> } = {}): Promise<LoadReport> {
    const loaded: string[] = [];
    const failed: ModuleFailure[] = [];
    const activated = new Map<string, string>(); // capabilityKey -> version
    const skip = new Set(options.skip ?? []);
    for (const m of modules) this.known.set(m.manifest.name, m);
    const pending = modules.filter((m) => !skip.has(m.manifest.name));

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
          await mod.activate(this.contextFor(mod.manifest.name));
          this.active.push(mod);
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

  /** Whether a module is active right now. */
  isActive(name: string): boolean {
    return this.active.some((m) => m.manifest.name === name);
  }

  /** Switch a known module off: deactivate it and take its tools back. */
  async disable(name: string): Promise<boolean> {
    const i = this.active.findIndex((m) => m.manifest.name === name);
    if (i === -1) return false;
    const [mod] = this.active.splice(i, 1);
    try {
      await mod!.deactivate?.();
    } catch {
      // Its tools go regardless; a module that will not let go still loses them.
    }
    for (const tool of this.tools.get(name) ?? []) this.ctx.unregisterTool?.(tool);
    this.tools.set(name, []);
    return true;
  }

  /** Switch a known module on again. */
  async enable(name: string): Promise<boolean> {
    if (this.isActive(name)) return true;
    const mod = this.known.get(name);
    if (!mod) return false;
    await mod.activate(this.contextFor(name));
    this.active.push(mod);
    return true;
  }

  /**
   * Deactivate everything that activated, last first, so a dependent is
   * gone before what it depended on. One module failing to let go does not
   * keep the rest from doing so; the failures are reported, not thrown.
   */
  async unload(): Promise<ModuleFailure[]> {
    const failed: ModuleFailure[] = [];
    for (const mod of this.active.splice(0).reverse()) {
      try {
        await mod.deactivate?.();
      } catch (err) {
        failed.push({ name: mod.manifest.name, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return failed;
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
