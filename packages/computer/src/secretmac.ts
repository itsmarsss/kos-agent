import { turnStop, type MacField, type MacFocus, type MacTyped, type SecretsMac } from "@kos/harness";

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
      const result = await hub.act(chat, "keys.secret", { ...params }, typingTimeout(params.text), turnStop.getStore());
      return typedOf(result);
    },
  };
}

/** How long the Mac is given to type a value: it types one character at a time, checking the field before each. */
export function typingTimeout(text: string): number {
  return Math.min(BASE_MS + text.length * PER_UNIT_MS, MAX_MS);
}
const BASE_MS = 15_000;
const PER_UNIT_MS = 60;
const MAX_MS = 300_000;

function typedOf(result: Record<string, unknown>): MacTyped {
  return typeof result["landed"] === "boolean" ? { landed: result["landed"] } : {};
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
          ...(field["page"] === true ? { page: true } : {}),
          ...(text(field["origin"]) ? { origin: text(field["origin"])! } : {}),
          ...(Array.isArray(field["frames"]) && field["frames"].every((f) => typeof f === "string") && field["frames"].length
            ? { frames: field["frames"] as string[] }
            : {}),
        }
      : undefined;
  return {
    ...(app && typeof app.name === "string" && typeof app.bundle === "string" && app.bundle ? { app: { name: app.name, bundle: app.bundle } } : {}),
    ...(read ? { field: read } : {}),
  };
}
