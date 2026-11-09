import { useSyncExternalStore } from "react";

import { isThemeMode, resolveThemeMode, type DrawnTheme, type ThemeMode } from "@kos/shared";

/**
 * Dark, light, or whatever the system says.
 *
 * KOS's own setting, kept in the workspace (`/api/settings/theme`): every
 * device that follows the dashboard draws it, and every tab of the
 * dashboard follows a change made in another. This browser keeps a copy
 * so the first paint is already right, and the status poll reconciles it
 * with the workspace's. System is the default.
 *
 * What a device set to the dashboard draws is the palette this tab draws,
 * "system" read in this browser, so the tab reports it whenever it changes.
 */

export type Theme = ThemeMode;
export const isTheme = isThemeMode;
export const resolveTheme = resolveThemeMode;

export const THEME_KEY = "kos.theme";

/** The copy this browser keeps, or nothing when it keeps none. */
export function readStoredTheme(): Theme | undefined {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return isTheme(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

export function readTheme(): Theme {
  return readStoredTheme() ?? "system";
}

const query = (): MediaQueryList | null =>
  typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: light)") : null;

let following: (() => void) | null = null;
const listeners = new Set<() => void>();

/** Put the palette on the document, and keep following the system while asked to. */
export function applyTheme(theme: Theme): void {
  following?.();
  following = null;
  const mq = query();
  const paint = (): void => {
    drawnNow = resolveTheme(theme, mq?.matches ?? false);
    document.documentElement.dataset["theme"] = drawnNow;
    reportSoon();
  };
  paint();
  if (theme === "system" && mq) {
    mq.addEventListener("change", paint);
    following = () => mq.removeEventListener("change", paint);
  }
}

/** The palette this tab draws in, and the one KOS last said a dashboard draws in. */
let drawnNow: DrawnTheme | undefined;
let drawnKept: DrawnTheme | undefined;
let report: ((drawn: DrawnTheme) => Promise<{ drawn: DrawnTheme }>) | null = null;
let reportTimer: ReturnType<typeof setTimeout> | undefined;

/** How long a change waits before it is reported, so a flurry of them is one report. */
export const DRAWN_REPORT_MS = 500;

/**
 * How often an open tab says its palette again when KOS already has it:
 * only to keep the report fresh, well inside the ten minutes KOS holds one
 * before devices draw the mode instead. A hidden tab keeps saying it, and
 * a browser that throttles a hidden tab's timers to once a minute still
 * fires this one in time.
 */
export const DRAWN_HEARTBEAT_MS = 3 * 60_000;

/** A palette KOS does not have, due to be said. */
function due(): boolean {
  return drawnNow !== undefined && drawnNow !== drawnKept;
}

function reportSoon(): void {
  if (!report || reportTimer !== undefined || !due()) return;
  reportTimer = setTimeout(() => void reportNow(), DRAWN_REPORT_MS);
}

async function reportNow(): Promise<void> {
  reportTimer = undefined;
  if (due()) await say(drawnNow!);
}

async function say(drawn: DrawnTheme): Promise<void> {
  if (!report) return;
  try {
    drawnKept = (await report(drawn)).drawn;
  } catch {
    // Unsaid this time; the next change, poll or heartbeat says it again.
  }
}

/**
 * The heartbeat: what KOS has is read first, since a hidden tab hears no
 * poll and another dashboard may have reported since. This tab's palette
 * is said again when KOS still has it, or has none; another dashboard's is
 * left alone.
 */
async function beat(read: () => Promise<DrawnTheme | undefined>): Promise<void> {
  if (!report || drawnNow === undefined || drawnNow !== drawnKept) return;
  try {
    drawnKept = await read();
  } catch {
    return;
  }
  if (drawnKept === undefined || drawnKept === drawnNow) await say(drawnNow);
}

/**
 * Report the palette this tab draws in to KOS, now and on every change of
 * it: a choice of theme here or in another tab, or the browser's own
 * appearance under "system". Only a palette that differs from what KOS
 * last said is reported, and changes close together are reported once.
 * One KOS has from this tab is said again every DRAWN_HEARTBEAT_MS, on a
 * timer of its own rather than the status poll, which a hidden tab skips,
 * so it does not go stale while the tab is open.
 */
export function reportDrawnTheme(
  send: (drawn: DrawnTheme) => Promise<{ drawn: DrawnTheme }>,
  read: () => Promise<DrawnTheme | undefined>,
): () => void {
  report = send;
  reportSoon();
  const heartbeat = setInterval(() => void beat(read), DRAWN_HEARTBEAT_MS);
  return () => {
    report = null;
    clearInterval(heartbeat);
    clearTimeout(reportTimer);
    reportTimer = undefined;
  };
}

/**
 * What KOS says a dashboard draws in, from the status poll. Another
 * dashboard's palette is not answered, so two dashboards never trade
 * reports. Nothing (none reported, or the last report went stale) is
 * answered with this tab's.
 */
export function heardDrawnTheme(drawn: DrawnTheme | undefined): void {
  drawnKept = drawn;
  if (drawn === undefined) reportSoon();
}

/** Show a theme in this tab and keep it as this browser's copy; the workspace is told apart, by whoever chose it. */
export function showTheme(theme: Theme): void {
  try {
    if (localStorage.getItem(THEME_KEY) !== theme) localStorage.setItem(THEME_KEY, theme);
  } catch {
    // A browser that refuses storage still gets the palette for this visit.
  }
  applyTheme(theme);
  for (const listener of listeners) listener();
}

/** The owner's choices made in this tab, and those of them KOS has not yet answered. */
let choices = 0;
let unsaved = 0;
let saving: Promise<unknown> = Promise.resolve();

/** Where this tab's choices stand, taken as a status is asked for: -1 while one is still being saved. */
export function themeStamp(): number {
  return unsaved ? -1 : choices;
}

/** The owner chose a theme here: shown at once, and saved after any choice before it, so the last one chosen is the one kept. */
export function chooseTheme(theme: Theme, save: (theme: Theme) => Promise<unknown>): Promise<void> {
  choices++;
  unsaved++;
  showTheme(theme);
  const saved = saving.then(() => save(theme)).finally(() => void unsaved--);
  saving = saved.catch(() => undefined);
  return saved.then(() => undefined);
}

/**
 * The workspace's theme, from the status poll, made this tab's. A status
 * asked for before the owner's latest choice here was saved is older than
 * it, and passed over. Before the owner has chosen one there, a choice this
 * browser kept from before is the owner's choice, so it is saved.
 */
export function reconcileTheme(kept: Theme | undefined, save: (theme: Theme) => unknown, stamp = themeStamp()): void {
  if (stamp < 0 || stamp !== themeStamp()) return;
  if (kept) {
    if (kept !== readStoredTheme()) showTheme(kept);
    return;
  }
  const local = readStoredTheme();
  if (local) save(local);
}

/** Another tab of this browser changed the theme: this one follows at once, before its next poll. */
export function followOtherTabs(): () => void {
  const heard = (e: StorageEvent): void => {
    if (e.key === THEME_KEY && isTheme(e.newValue)) showTheme(e.newValue);
  };
  addEventListener("storage", heard);
  return () => removeEventListener("storage", heard);
}

/** The theme this tab shows, kept current whoever changed it. */
export function useTheme(): Theme {
  return useSyncExternalStore((change) => {
    listeners.add(change);
    return () => listeners.delete(change);
  }, readTheme);
}

/**
 * How much fits on the screen.
 *
 * Every size in the app is in rem, so the root size is the one knob that
 * moves type and spacing together: compact fits more rows on a laptop,
 * comfortable gives a phone or a long read some air. Standard is what it
 * always was.
 */
export type Density = "compact" | "standard" | "comfortable";

export const DENSITY_KEY = "kos.density";

export function isDensity(v: unknown): v is Density {
  return v === "compact" || v === "standard" || v === "comfortable";
}

export function readDensity(): Density {
  try {
    const v = localStorage.getItem(DENSITY_KEY);
    return isDensity(v) ? v : "standard";
  } catch {
    return "standard";
  }
}

export function applyDensity(density: Density): void {
  if (density === "standard") delete document.documentElement.dataset["density"];
  else document.documentElement.dataset["density"] = density;
}

export function setDensity(density: Density): void {
  try {
    localStorage.setItem(DENSITY_KEY, density);
  } catch {
    // Still applied for this visit.
  }
  applyDensity(density);
}
