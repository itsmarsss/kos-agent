import { ARTIFACT_FONTS, ARTIFACT_KINDS } from "@kos/shared";
import { describe, expect, it } from "vitest";

import { GUIDE_PARTS, artifactGuide } from "./artifactguide.js";

const words = (s: string): number => s.split(/\s+/).filter(Boolean).length;

describe("artifactGuide", () => {
  it("gives the general part and only the named kind's part", () => {
    for (const kind of ARTIFACT_KINDS) {
      const text = artifactGuide(kind);
      expect(text).toContain(GUIDE_PARTS.general);
      expect(text).toContain(GUIDE_PARTS[kind]);
      for (const other of ARTIFACT_KINDS.filter((k) => k !== kind)) expect(text).not.toContain(GUIDE_PARTS[other]);
    }
  });

  it("points to each kind when none is named, without any kind's part", () => {
    const text = artifactGuide();
    for (const kind of ARTIFACT_KINDS) {
      expect(text).toContain(`- ${kind}:`);
      expect(text).not.toContain(GUIDE_PARTS[kind]);
    }
  });

  it("names every bundled font and how to use it", () => {
    const text = artifactGuide("doc");
    for (const font of ARTIFACT_FONTS) expect(text).toContain(`var(--font-${font.id})`);
  });

  it("teaches the theme pattern the toggle wins both ways with", () => {
    const text = artifactGuide();
    expect(text).toContain("@media (prefers-color-scheme: dark) { :root:not([data-theme=light])");
    expect(text).toContain(":root[data-theme=dark]");
    expect(text).toContain("data-theme and data-mode");
  });

  it("starts from KOS's own tokens and keeps a token plan for a distinctive piece", () => {
    const text = artifactGuide();
    for (const token of ["--bg", "--panel", "--line", "--text", "--muted", "--accent"]) expect(text).toContain(token);
    expect(text).toMatch(/KOS's own look, the default/);
    expect(text).toMatch(/Distinctive, only for a piece clearly meant to stand apart/);
    expect(text).not.toMatch(/--paper: #/);
    // --faint is below AA for text in light: labels are --muted.
    expect(text).not.toMatch(/color: var\(--faint\)/);
  });

  it("names the generated looks the check now looks for", () => {
    const text = artifactGuide();
    for (const look of [/inverted title slide or band/, /figure tiles reading 0/, /a card around every section/, /duplicate headers/, /many queries at once/]) expect(text).toMatch(look);
  });

  it("says to check once and fix in one pass", () => {
    expect(artifactGuide()).toContain("Fix everything the check reports in one pass, write again, then finish.");
  });

  it("holds the runtimes' structure for each kind", () => {
    expect(artifactGuide("doc")).toContain("<article data-doc>");
    expect(artifactGuide("deck")).toContain("<main data-deck>");
    expect(artifactGuide("sheet")).toContain('<script type="application/json" data-sheet>');
    expect(artifactGuide("page")).toContain("kos.query(sql, params?)");
  });

  it("has no dashes or emoji, and stays within its length", () => {
    for (const [name, part] of Object.entries(GUIDE_PARTS)) {
      expect(part, name).not.toMatch(/[–—]/);
      expect(part, name).not.toMatch(/\p{Extended_Pictographic}/u);
      const n = words(part);
      if (name === "general") expect(n).toBeGreaterThan(1200);
      else expect(n, name).toBeGreaterThan(400);
      expect(n, name).toBeLessThan(name === "general" ? 2400 : 900);
    }
  });

  it("says the check is not available where KOS has no Chrome, instead of asking for one", () => {
    const text = artifactGuide("doc", false);
    expect(text).not.toMatch(/Check it once with artifacts.check/);
    expect(text).toMatch(/artifacts.check is not available here; do not call it/);
    expect(artifactGuide("doc")).toMatch(/Check it once with artifacts.check/);
  });
});
