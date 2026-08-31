import type { ToolDef } from "../models/types.js";
import { classifyRisk, SAFE, type RiskAssessment, type ToolRisk } from "../risk/tiers.js";

/**
 * Executes a tool call. Receives the parsed input object and returns a string
 * result (the content fed back to the model). Throwing is allowed; the registry
 * converts a throw into an error tool result so the agent can recover.
 */
export type ToolHandler = (
  input: Record<string, unknown>,
) => Promise<string> | string;

/** Optional registration metadata, e.g. scope tags for tool scoping. */
export interface ToolMeta {
  /**
   * Scope tags. A tool with no tags is "global" (always offered). A tagged tool
   * is offered only when one of its tags is in the active scope, so the agent
   * is not flooded with every tool every turn.
   */
  tags?: string[];
  /**
   * Withheld unless a caller explicitly grants it. Scope tags are advisory
   * (they only decide what is *surfaced*); this is a lock. Use it for tools
   * that must not be reachable from an ordinary conversation at all.
   */
  restricted?: boolean;
}

export interface RegisteredTool {
  def: ToolDef;
  handler: ToolHandler;
  risk: ToolRisk;
  tags: string[];
  restricted: boolean;
}

export interface ToolExecution {
  content: string;
  isError: boolean;
}

export interface ScopeOptions {
  /** Active scope tags (e.g. the current project/instance). */
  tags?: string[];
  /** Cap the number of tools returned (global first, then scoped). */
  limit?: number;
}

/**
 * The set of tools the agent can call. Tools are primitives the agent composes;
 * the registry is the contract everything (built-in tools, agent-written
 * skills) registers against.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(
    def: ToolDef,
    handler: ToolHandler,
    risk: ToolRisk = SAFE,
    meta: ToolMeta = {},
  ): void {
    if (this.tools.has(def.name)) {
      throw new Error(`tool already registered: ${def.name}`);
    }
    this.tools.set(def.name, {
      def,
      handler,
      risk,
      tags: meta.tags ?? [],
      restricted: meta.restricted === true,
    });
  }

  /**
   * Compute the risk tier for a prospective tool call. Unknown tools are risky
   * by default, so an unrecognized call never runs unguarded.
   */
  classify(name: string, input: Record<string, unknown>): RiskAssessment {
    const tool = this.tools.get(name);
    if (!tool) return { tier: "risky", escalated: false };
    return classifyRisk(tool.risk, input);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /** How many tools are registered. */
  get size(): number {
    return this.tools.size;
  }

  /** All unrestricted tool definitions, for passing to the model. */
  defs(): ToolDef[] {
    return [...this.tools.values()].filter((t) => !t.restricted).map((t) => t.def);
  }

  /** Definitions for named restricted tools, granted explicitly by a caller. */
  restrictedDefs(names: string[]): ToolDef[] {
    const wanted = new Set(names);
    return [...this.tools.values()]
      .filter((t) => t.restricted && wanted.has(t.def.name))
      .map((t) => t.def);
  }

  isRestricted(name: string): boolean {
    return this.tools.get(name)?.restricted === true;
  }

  /**
   * Scoped tool definitions: global tools (no tags) plus tools whose tags
   * intersect the active scope, optionally capped. This is how the agent loop
   * surfaces only relevant tools instead of every tool every turn.
   */
  scopedDefs(opts: ScopeOptions = {}): ToolDef[] {
    const active = new Set(opts.tags ?? []);
    const selected = [...this.tools.values()].filter(
      (t) =>
        !t.restricted &&
        (t.tags.length === 0 || t.tags.some((tag) => active.has(tag))),
    );
    const defs = selected.map((t) => t.def);
    return opts.limit !== undefined ? defs.slice(0, opts.limit) : defs;
  }

  /**
   * Run a tool by name. Unknown tools and handler throws both come back as
   * error results rather than exceptions, so the agent loop stays alive and the
   * model can adapt.
   */
  async execute(
    name: string,
    input: Record<string, unknown>,
  ): Promise<ToolExecution> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { content: `unknown tool: ${name}`, isError: true };
    }
    try {
      const content = await tool.handler(input);
      return { content, isError: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: `tool error: ${message}`, isError: true };
    }
  }
}
