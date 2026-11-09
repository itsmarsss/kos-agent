import { useSyncExternalStore } from "react";

import { isThemeMode, resolveThemeMode, type ThemeMode } from "@kos/shared";

/**
 * Dark, light, or whatever the system says.
 *
 * KOS's own setting, kept in the workspace (`/api/settings/theme`): every
 * device that follows the dashboard draws it, and every tab of the
 * dashboard follows a change made in another. This browser keeps a copy
 * so the first paint is already right, and the status poll reconciles it
 * with the workspace's. System is the default.
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
    document.documentElement.dataset["theme"] = resolveTheme(theme, mq?.matches ?? false);
  };
  paint();
  if (theme === "system" && mq) {
    mq.addEventListener("change", paint);
    following = () => mq.removeEventListener("change", paint);
  }
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

/**
 * The workspace's theme, from the status poll, made this tab's. Before the
 * owner has chosen one there, a choice this browser kept from before is
 * the owner's choice, so it is saved.
 */
export function reconcileTheme(kept: Theme | undefined, save: (theme: Theme) => unknown): void {
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
