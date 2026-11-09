/**
 * The extension's theme, put on each of its pages (the popup, the side
 * panel, the consent window) before their first paint, and kept current.
 *
 * The owner's choice in Settings, "Same as dashboard" by default, which
 * draws what the KOS the toolbar speaks of sent (`{ t: "theme" }`): the
 * palette its dashboard is drawn in, else its mode, and the system's
 * appearance before that KOS has sent one. A classic
 * script in each page's head, so the palette is on before anything is
 * drawn: this page's copy of the last answer first, at once, then what is
 * stored, and again whenever the setting or the dashboard changes, in every
 * page open.
 */

import { isThemeMode, resolveThemeMode, type ThemeMode } from "@kos/shared/design";

import { readSettings, SENT_THEME_KEY, themeOf } from "./settings.js";

/** The pages' copy of the mode, in their shared localStorage, for the first paint. */
const CACHE_KEY = "kos.theme";

function cached(): ThemeMode {
  try {
    const v = localStorage.getItem(CACHE_KEY);
    return isThemeMode(v) ? v : "system";
  } catch {
    return "system";
  }
}

function follow(): void {
  const root = document.documentElement;
  const light = matchMedia("(prefers-color-scheme: light)");
  let mode = cached();
  const paint = (): void => {
    root.dataset["theme"] = resolveThemeMode(mode, light.matches);
  };
  const read = async (): Promise<void> => {
    const kept = await chrome.storage.local.get(["settings", SENT_THEME_KEY]);
    mode = themeOf(readSettings(kept["settings"]).theme, kept[SENT_THEME_KEY]);
    try {
      localStorage.setItem(CACHE_KEY, mode);
    } catch {
      // Without the copy the next page paints the system's first, then this.
    }
    paint();
  };
  paint();
  light.addEventListener("change", paint);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && ("settings" in changes || SENT_THEME_KEY in changes)) void read();
  });
  void read();
}

follow();
