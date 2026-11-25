/**
 * A scheduled run's quiet ending: notify called with `quiet` and the reason
 * it posts nothing, and nothing a message is made of. The harness refuses
 * any other shape; a surface reads one this way alone.
 */

/** What a notify message is made of: a quiet ending carries none of it. */
const NOTIFY_MESSAGE_KEYS = ["text", "card", "buttons", "to", "replyTo"] as const;

/** The message keys a notify call sets, empty ones aside. */
export function messageKeysIn(args: Record<string, unknown>): string[] {
  return NOTIFY_MESSAGE_KEYS.filter((key) => {
    const value = args[key];
    return value !== undefined && value !== null && value !== "" && !(Array.isArray(value) && value.length === 0);
  });
}

/** The reason a call's `quiet` gives, on one line without its closing stop; empty when it gives none. */
export function quietWords(args: Record<string, unknown>): string {
  return typeof args.quiet === "string" ? args.quiet.replace(/\s+/g, " ").trim().replace(/\.+$/, "") : "";
}

/** Why a notify call posts nothing, when it is a quiet ending as the harness takes one; undefined for any other call. */
export function quietReason(args: Record<string, unknown>): string | undefined {
  const reason = quietWords(args);
  return reason && messageKeysIn(args).length === 0 ? reason : undefined;
}
