import type { KosModule } from "../modules/loader.js";
import { requireServices } from "../modules/loader.js";

/**
 * The `notify` tool module: send a message to the user via the active channel
 * adapter. Safe tier (no money, no credentials, no external API), so it runs
 * immediately. Requires a notify sender wired into module services.
 */
export const notifyModule: KosModule = {
  manifest: {
    name: "notify",
    version: "1.0.0",
    provides: [{ kind: "tool", name: "notify", version: "1.0.0" }],
    riskTier: "safe",
  },
  activate(ctx) {
    const services = requireServices(ctx);
    ctx.registerTool(
      {
        name: "notify",
        description: "Send a message to the user via their messaging channel.",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
      async (input) => {
        const text = input.text;
        if (typeof text !== "string") throw new Error("notify requires text");
        if (!services.notify) throw new Error("no notify channel is wired");
        await services.notify(text);
        return "sent";
      },
      { floor: "safe" },
    );
  },
};
