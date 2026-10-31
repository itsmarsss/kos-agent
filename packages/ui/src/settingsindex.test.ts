import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { SECTIONS, SETTINGS, fuzzy, searchSettings } from "./settingsindex.js";

/**
 * Finding a setting by a few letters of its name, and the list of settings
 * kept in step with the page that shows them.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** Every literal label the page writes, by the section block it sits in. */
function labelsInPage(): { section: string; label: string }[] {
  const source = readFileSync(join(here, "SettingsPage.tsx"), "utf8");
  const starts = [...source.matchAll(/\{active === "([a-z]+)" && \(/g)].map((m) => ({ at: m.index!, section: m[1]! }));
  const out: { section: string; label: string }[] = [];
  starts.forEach(({ at, section }, i) => {
    const block = source.slice(at, starts[i + 1]?.at ?? source.length);
    for (const m of block.matchAll(/<Field\b[^>]*?\blabel="([^"]+)"/gs)) out.push({ section, label: m[1]! });
    for (const m of block.matchAll(/<h3>([^<{]+)<\/h3>/g)) out.push({ section, label: m[1]!.trim() });
  });
  return out;
}

describe("the settings a search can find", () => {
  it("include every setting and heading the page writes out", () => {
    const known = new Set(SETTINGS.map((e) => `${e.section}|${e.label}`));
    const missing = labelsInPage().filter((l) => !known.has(`${l.section}|${l.label}`));
    expect(missing).toEqual([]);
  });

  it("name only sections there are", () => {
    const ids = new Set<string>(SECTIONS.map((s) => s.id));
    expect(SETTINGS.filter((e) => !ids.has(e.section))).toEqual([]);
  });
});

describe("a fuzzy match", () => {
  it("finds the letters in order, best where they run together and start words", () => {
    expect(fuzzy("chrom", "Chrome to run")?.score).toBeGreaterThan(fuzzy("chrom", "The Chrome KOS drives")?.score ?? 0);
    expect(fuzzy("ctr", "Chrome to run")).toMatchObject({ marks: [0, 7, 10] });
    expect(fuzzy("xyz", "Chrome to run")).toBeUndefined();
    expect(fuzzy("", "anything")).toEqual({ score: 0, marks: [] });
  });

  it("puts the setting named first, then the section, and reads words in any order", () => {
    expect(searchSettings("theme")[0]).toMatchObject({ section: "appearance", label: "Theme" });
    expect(searchSettings("devices")[0]).toMatchObject({ section: "devices" });
    expect(searchSettings("headless")[0]).toMatchObject({ section: "browser", label: "Show the window on this machine" });
    expect(searchSettings("approval wait")[0]).toMatchObject({ label: "Minutes to wait for your approval" });
    expect(searchSettings("tmzn")[0]).toMatchObject({ label: "Timezone" });
    expect(searchSettings("   ")).toEqual([]);
  });

  it("finds what the host describes, by its own words", () => {
    const hits = searchSettings("anthropic", [...SETTINGS, { section: "providers", label: "Anthropic API key", words: "Claude models" }]);
    expect(hits[0]).toMatchObject({ section: "providers", label: "Anthropic API key" });
  });
});
