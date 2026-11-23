import { useEffect, type ReactElement } from "react";

/**
 * The one voice for a screen reader: two regions, polite and assertive,
 * mounted once and present from the first frame, which `announce` writes
 * into. A region made at the moment it speaks is not heard by many readers,
 * so toasts, an approval arriving, a save, an error and a load finishing all
 * say themselves here rather than through a live node of their own.
 */
export type Politeness = "polite" | "assertive";

const REGION: Record<Politeness, string> = { polite: "kos-announce-polite", assertive: "kos-announce-assertive" };

/** Long enough for a reader to see the region empty before it fills again, so the same words twice are said twice. */
export const ANNOUNCE_GAP_MS = 60;

const pending = new Map<Politeness, ReturnType<typeof setTimeout>>();

/** Say `text` to a screen reader; an assertive one interrupts, for an error. Nothing when the regions are not mounted. */
export function announce(text: string, politeness: Politeness = "polite"): void {
  const region = document.getElementById(REGION[politeness]);
  const words = text.trim();
  if (!region || !words) return;
  const was = pending.get(politeness);
  if (was !== undefined) clearTimeout(was);
  region.textContent = "";
  pending.set(
    politeness,
    setTimeout(() => {
      pending.delete(politeness);
      region.textContent = words;
    }, ANNOUNCE_GAP_MS),
  );
}

/** The two regions, out of sight. Mounted once, by the app. */
export function Announcer(): ReactElement {
  useEffect(
    () => () => {
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    },
    [],
  );
  return (
    <div className="sr-only">
      <div id={REGION.polite} role="status" aria-live="polite" aria-atomic="true" />
      <div id={REGION.assertive} role="alert" aria-live="assertive" aria-atomic="true" />
    </div>
  );
}
