// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { chooseTheme, DRAWN_REPORT_MS, followOtherTabs, heardDrawnTheme, isDensity, isTheme, readTheme, reconcileTheme, reportDrawnTheme, resolveTheme, showTheme, THEME_KEY, themeStamp } from "./theme.js";

afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset["theme"];
});

describe("the theme choice", () => {
  it("lands dark or light on its own, and follows the system when asked", () => {
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("light", false)).toBe("light");
    expect(resolveTheme("system", true)).toBe("light");
    expect(resolveTheme("system", false)).toBe("dark");
  });

  it("treats anything else stored as the default, which is the system's", () => {
    expect(isTheme("light")).toBe(true);
    expect(isTheme("sepia")).toBe(false);
    expect(isTheme(null)).toBe(false);
    expect(isDensity("comfortable")).toBe(true);
    expect(isDensity("cozy")).toBe(false);
    expect(readTheme()).toBe("system");
    localStorage.setItem(THEME_KEY, "sepia");
    expect(readTheme()).toBe("system");
  });
});

describe("the theme kept in the workspace", () => {
  it("is this tab's, and this browser's copy for the first paint, once the status brings it", () => {
    localStorage.setItem(THEME_KEY, "dark");
    const save = vi.fn();
    reconcileTheme("light", save);
    expect(readTheme()).toBe("light");
    expect(document.documentElement.dataset["theme"]).toBe("light");
    expect(save).not.toHaveBeenCalled();
  });

  it("is seeded from this browser's choice before the owner chose one in the workspace", () => {
    const save = vi.fn();
    reconcileTheme(undefined, save);
    // Nothing kept here either: the default is nobody's choice, so nothing is saved.
    expect(save).not.toHaveBeenCalled();
    localStorage.setItem(THEME_KEY, "light");
    reconcileTheme(undefined, save);
    expect(save).toHaveBeenCalledWith("light");
  });

  it("is followed at once when another tab of this browser changes it", () => {
    const stop = followOtherTabs();
    showTheme("dark");
    localStorage.setItem(THEME_KEY, "light");
    dispatchEvent(new StorageEvent("storage", { key: THEME_KEY, newValue: "light" }));
    expect(document.documentElement.dataset["theme"]).toBe("light");
    // Something else stored is not a theme to follow.
    dispatchEvent(new StorageEvent("storage", { key: THEME_KEY, newValue: "sepia" }));
    expect(document.documentElement.dataset["theme"]).toBe("light");
    stop();
  });

  it("passes over a status asked for before the owner's latest choice here was saved, and saves the choices in order", async () => {
    showTheme("dark");
    const saved: string[] = [];
    const asked: (() => void)[] = [];
    const save = (theme: string): Promise<void> => new Promise((r) => void asked.push(() => (saved.push(theme), r())));
    const answer = async (): Promise<void> => {
      await vi.waitFor(() => expect(asked.length).toBeGreaterThan(0));
      asked.shift()!();
    };
    const before = themeStamp();
    const first = chooseTheme("light", save);
    const second = chooseTheme("system", save);
    // Asked before the choices, or while they are saved: older than them.
    reconcileTheme("dark", vi.fn(), before);
    reconcileTheme("dark", vi.fn(), themeStamp());
    expect(readTheme()).toBe("system");
    await answer();
    await first;
    // The second is saved only after the first was answered, so KOS keeps the last chosen.
    expect(saved).toEqual(["light"]);
    await answer();
    await second;
    expect(saved).toEqual(["light", "system"]);
    // A status asked for once both were saved is the workspace's own again.
    reconcileTheme("dark", vi.fn(), themeStamp());
    expect(readTheme()).toBe("dark");
  });

  it("goes back to the workspace's when a choice was not saved", async () => {
    showTheme("dark");
    await expect(chooseTheme("light", () => Promise.reject(new Error("offline")))).rejects.toThrow("offline");
    reconcileTheme("dark", vi.fn(), themeStamp());
    expect(readTheme()).toBe("dark");
  });
});

describe("the palette this tab reports drawing in", () => {
  /** A browser whose own appearance can be changed, as matchMedia sees it. */
  function browser(prefersLight: boolean): { set: (light: boolean) => void; restore: () => void } {
    const heard = new Set<() => void>();
    const mq = {
      get matches() {
        return prefersLight;
      },
      addEventListener: (_: string, f: () => void) => void heard.add(f),
      removeEventListener: (_: string, f: () => void) => void heard.delete(f),
    };
    vi.stubGlobal("matchMedia", () => mq);
    return {
      set: (light) => {
        prefersLight = light;
        for (const f of heard) f();
      },
      restore: () => vi.unstubAllGlobals(),
    };
  }

  it("is reported on load, on a change of theme and of the browser's appearance, and only when KOS has another", async () => {
    vi.useFakeTimers();
    const chrome = browser(false);
    const sent: string[] = [];
    const send = vi.fn(async (drawn: "light" | "dark") => (sent.push(drawn), { drawn }));
    showTheme("system");
    const stop = reportDrawnTheme(send);
    // On load: KOS has said nothing, so the dark this browser draws "system" in is reported.
    await vi.advanceTimersByTimeAsync(DRAWN_REPORT_MS);
    expect(sent).toEqual(["dark"]);
    // The same palette again, by a different road, is no news.
    showTheme("dark");
    await vi.advanceTimersByTimeAsync(DRAWN_REPORT_MS);
    expect(sent).toEqual(["dark"]);
    // The browser turns light under "system": reported.
    showTheme("system");
    chrome.set(true);
    await vi.advanceTimersByTimeAsync(DRAWN_REPORT_MS);
    expect(sent).toEqual(["dark", "light"]);
    // A flurry of changes is one report, of where it settled.
    chrome.set(false);
    chrome.set(true);
    chrome.set(false);
    await vi.advanceTimersByTimeAsync(DRAWN_REPORT_MS);
    expect(sent).toEqual(["dark", "light", "dark"]);
    // KOS already says light (another dashboard's report): a change to light here sends nothing, and hearing it sent nothing either.
    heardDrawnTheme("light");
    await vi.advanceTimersByTimeAsync(DRAWN_REPORT_MS);
    expect(sent).toEqual(["dark", "light", "dark"]);
    showTheme("light");
    await vi.advanceTimersByTimeAsync(DRAWN_REPORT_MS);
    expect(sent).toEqual(["dark", "light", "dark"]);
    stop();
    showTheme("dark");
    await vi.advanceTimersByTimeAsync(DRAWN_REPORT_MS);
    expect(sent).toHaveLength(3);
    chrome.restore();
    vi.useRealTimers();
  });

  it("never answers another dashboard's palette, and says its own when KOS has none", async () => {
    vi.useFakeTimers();
    const chrome = browser(false);
    const sent: string[] = [];
    const send = vi.fn(async (drawn: "light" | "dark") => (sent.push(drawn), { drawn }));
    heardDrawnTheme(undefined);
    showTheme("system");
    const stop = reportDrawnTheme(send);
    await vi.advanceTimersByTimeAsync(DRAWN_REPORT_MS);
    expect(sent).toEqual(["dark"]);
    // KOS keeps it, so an open tab never says it again only to keep it.
    heardDrawnTheme("dark");
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(sent).toEqual(["dark"]);
    // Another dashboard's palette is never answered.
    heardDrawnTheme("light");
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(sent).toEqual(["dark"]);
    // KOS has none (a fresh workspace): this tab's is said at once.
    heardDrawnTheme(undefined);
    await vi.advanceTimersByTimeAsync(DRAWN_REPORT_MS);
    expect(sent).toEqual(["dark", "dark"]);
    stop();
    chrome.restore();
    vi.useRealTimers();
  });

  it("is reported again on the next change after a report that failed", async () => {
    vi.useFakeTimers();
    heardDrawnTheme(undefined);
    showTheme("light");
    const send = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ drawn: "dark" });
    const stop = reportDrawnTheme(send);
    await vi.advanceTimersByTimeAsync(DRAWN_REPORT_MS);
    expect(send).toHaveBeenCalledWith("light");
    showTheme("dark");
    await vi.advanceTimersByTimeAsync(DRAWN_REPORT_MS);
    expect(send).toHaveBeenLastCalledWith("dark");
    expect(send).toHaveBeenCalledTimes(2);
    stop();
    vi.useRealTimers();
  });
});
