/**
 * Dark, light, or whatever the system says.
 *
 * Kept in this browser rather than in the workspace: which palette suits a
 * screen is a property of the screen, and the same owner on a phone in the
 * sun and a desk at night wants different answers. Dark is the default, as it
 * always was; nothing changes for anyone who never opens the setting.
 */

export type Theme = "dark" | "light" | "system";

export const THEME_KEY = "kos.theme";

export function isTheme(v: unknown): v is Theme {
  return v === "dark" || v === "light" || v === "system";
}

export function readTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return isTheme(v) ? v : "dark";
  } catch {
    return "dark";
  }
}

/** The palette a choice lands on, given what the system prefers. */
export function resolveTheme(theme: Theme, prefersLight: boolean): "dark" | "light" {
  if (theme === "system") return prefersLight ? "light" : "dark";
  return theme;
}

const query = (): MediaQueryList | null =>
  typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: light)") : null;

let following: (() => void) | null = null;

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

export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // A browser that refuses storage still gets the palette for this visit.
  }
  applyTheme(theme);
}
