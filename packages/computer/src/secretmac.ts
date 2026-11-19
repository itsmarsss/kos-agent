import { turnStop, type MacField, type MacFocus, type SecretsMac } from "@kos/harness";

import type { DeviceHub } from "./hub.js";
import { DeviceError } from "./link.js";

/**
 * The calling chat's Mac as secrets.type reaches it: its session, the field
 * in focus there (keys.focus), and the one call that carries a secret's
 * value (keys.secret), which the hub sends as built and the link leaves
 * unscrubbed (docs/secrets.md). Nothing here keeps the value or says it.
 */
export function macSecrets(hub: DeviceHub): SecretsMac {
  return {
    session(chat) {
      const session = hub.sessionOf(chat);
      const device = session ? hub.list().find((d) => d.id === session.device) : undefined;
      if (!session || !device) return "No session on a Mac in this chat. computer.start asks the owner for one; in the KOS for Mac window, computer.act starts one itself.";
      if (device.kind !== "computer") return "This chat's session is in the owner's Chrome, not on a Mac: secrets.fill fills a page there.";
      return { id: session.id, device: { id: device.id, name: device.name } };
    },
    async focus(chat) {
      try {
        return focusOf(await hub.act(chat, "keys.focus", {}, undefined, turnStop.getStore()));
      } catch (err) {
        // A KOS for Mac from before keys.focus types no secret.
        if (err instanceof DeviceError && err.code === "bad_request") throw new DeviceError("bad_request", "KOS for Mac on this Mac is too old to type a saved secret; the owner updates it first.");
        throw err;
      }
    },
    async type(chat, params, step) {
      // The step on the Mac's bar and in its menu, as computer.act's are: never the value.
      hub.tellStatus(chat, { step });
      await hub.act(chat, "keys.secret", { ...params }, undefined, turnStop.getStore());
    },
  };
}

/** keys.focus's answer, read as far as it holds. */
function focusOf(result: Record<string, unknown>): MacFocus {
  const app = result["app"] as { name?: unknown; bundle?: unknown } | undefined;
  const field = result["field"] as Record<string, unknown> | undefined;
  const text = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
  const read: MacField | undefined =
    field && typeof field["role"] === "string" && typeof field["secure"] === "boolean"
      ? {
          role: field["role"],
          secure: field["secure"],
          // Kept as said, an empty title too: the Mac checks it again against what it is told here.
          ...(typeof field["window"] === "string" ? { window: field["window"] } : {}),
          ...(text(field["label"]) ? { label: text(field["label"])! } : {}),
          ...(text(field["placeholder"]) ? { placeholder: text(field["placeholder"])! } : {}),
          ...(text(field["origin"]) ? { origin: text(field["origin"])! } : {}),
        }
      : undefined;
  return {
    ...(app && typeof app.name === "string" && typeof app.bundle === "string" && app.bundle ? { app: { name: app.name, bundle: app.bundle } } : {}),
    ...(read ? { field: read } : {}),
  };
}
