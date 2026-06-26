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

export interface RegisteredTool {
  def: ToolDef;
  handler: ToolHandler;
  risk: ToolRisk;
}

export interface ToolExecution {
  content: string;
  isError: boolean;
}

/**
 * The set of tools the agent can call. Tools are primitives the agent composes;
 * the registry is the contract everything (built-in tools, agent-written
 * skills) registers against.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(def: ToolDef, handler: ToolHandler, risk: ToolRisk = SAFE): void {
    if (this.tools.has(def.name)) {
      throw new Error(`tool already registered: ${def.name}`);
    }
    this.tools.set(def.name, { def, handler, risk });
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

  /** All tool definitions, for passing to the model. */
  defs(): ToolDef[] {
    return [...this.tools.values()].map((t) => t.def);
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
