// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { chooseTheme, followOtherTabs, isDensity, isTheme, readTheme, reconcileTheme, resolveTheme, showTheme, THEME_KEY, themeStamp } from "./theme.js";

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
