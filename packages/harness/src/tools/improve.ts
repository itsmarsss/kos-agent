import type { KosModule, ModuleContext } from "../modules/loader.js";
import type { SuggestionKind, SuggestionStore } from "../improve/store.js";

/**
 * The `improve` tools: how KOS raises a suggestion and sees what it has
 * already raised. Both safe: a suggestion changes nothing. Carrying one out
 * is the owner's to accept, and happens through the ordinary gated tools.
 */

export interface ImproveModuleDeps {
  suggestions: SuggestionStore;
}

function str(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== "string" || v.trim() === "") throw new Error(`${key} is required`);
  return v.trim();
}

export function createImproveModule(deps: ImproveModuleDeps): KosModule {
  return {
    manifest: {
      name: "improve",
      version: "1.0.0",
      provides: [
        { kind: "tool", name: "improve.suggest", version: "1.0.0" },
        { kind: "tool", name: "improve.list", version: "1.0.0" },
      ],
      riskTier: "safe",
    },
    activate(ctx: ModuleContext) {
      ctx.registerTool(
        {
          name: "improve.list",
          description:
            "What you have already suggested to the owner and they have not yet answered. Call it before suggesting, so you do not raise the same thing twice.",
          inputSchema: { type: "object", properties: {} },
        },
        () =>
          JSON.stringify({
            open: deps.suggestions.pending().map((s) => ({ kind: s.kind, title: s.title })),
          }),
        { floor: "safe" },
        { tags: ["improve"] },
      );

      ctx.registerTool(
        {
          name: "improve.suggest",
          description:
            "Suggest to the owner something you could make reusable: a blueprint from projects of the same shape, or a skill from a task done by hand more than once. This only raises the suggestion; it creates nothing. The owner accepts it in their Inbox, and only then is it carried out, with the usual approvals.",
          inputSchema: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["skill", "blueprint", "other"] },
              title: { type: "string", description: "a short name, as it reads in a list" },
              detail: { type: "string", description: "what you saw: the evidence, named" },
              action: { type: "string", description: "the plain instruction you would carry out if the owner says yes" },
            },
            required: ["kind", "title", "detail"],
          },
        },
        (input) => {
          const kind = input.kind as SuggestionKind;
          const s = deps.suggestions.add(kind, str(input, "title"), str(input, "detail"), typeof input.action === "string" ? input.action : undefined);
          return JSON.stringify({ suggested: s.id, kind: s.kind, title: s.title });
        },
        { floor: "safe" },
        { tags: ["improve"] },
      );
    },
  };
}
