import type { ResultShelf } from "../context/shelf.js";
import type { KosModule, ModuleContext } from "../modules/loader.js";

/**
 * context.recall: a big result back from the shelf, in part.
 *
 * A page, a PDF or a long query that a chat read some turns ago is no longer
 * sent with every message; its stub names a handle. This brings back what is
 * needed of it: the passages around a search, or a range of characters.
 */
export function createRecallModule(shelf: () => ResultShelf | undefined): KosModule {
  return {
    manifest: {
      name: "recall",
      version: "1.0.0",
      provides: [{ kind: "tool", name: "context.recall", version: "1.0.0" }],
      riskTier: "safe",
    },
    activate(ctx: ModuleContext) {
      ctx.registerTool(
        {
          name: "context.recall",
          description:
            "Bring back part of a big result this chat read earlier and set aside: a page, a document, a long listing. Its stub in the chat names the handle. " +
            "Give `search` (words to find; the passages around them come back) or `from` and `to` (character offsets). Prefer a search; read a range when you need it in order.",
          inputSchema: {
            type: "object",
            properties: {
              handle: { type: "string", description: "the r_ handle the stub names" },
              search: { type: "string" },
              from: { type: "number", minimum: 0 },
              to: { type: "number", minimum: 0 },
            },
            required: ["handle"],
          },
        },
        (input) => {
          const s = shelf();
          if (!s) return "set-aside results are switched off in Settings, Behaviour";
          const handle = typeof input.handle === "string" ? input.handle.trim() : "";
          return s.recall(handle, {
            ...(typeof input.search === "string" ? { search: input.search } : {}),
            ...(typeof input.from === "number" ? { from: input.from } : {}),
            ...(typeof input.to === "number" ? { to: input.to } : {}),
          });
        },
      );
    },
  };
}
