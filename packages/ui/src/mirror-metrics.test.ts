import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The composer draws its text twice: a mirror underneath carries the colour,
 * the textarea on top carries the caret. They only stay aligned while nothing
 * in the mirror changes how wide the text is, and the textarea cannot be given
 * matching styles because it cannot style its own contents.
 *
 * Padding on a reference put the caret a fifth of an em left of the text for
 * every reference in the message. This guards the invariant rather than the
 * one property that broke it.
 */

const css = readFileSync(join(__dirname, "styles.css"), "utf8");

function ruleFor(selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  if (at < 0) throw new Error(`no rule for ${selector}`);
  return css.slice(at, css.indexOf("}", at));
}

function ems(value: string | undefined): number {
  if (!value) return 0;
  const m = /(-?[\d.]+)em/.exec(value);
  return m ? Number(m[1]) : 0;
}

describe("composer mirror metrics", () => {
  const rule = ruleFor(".hl-ref");

  it("cancels any horizontal padding with an equal negative margin", () => {
    const padding = ems(/padding:\s*([^;]+)/.exec(rule)?.[1]?.split(/\s+/)[1]);
    const margin = ems(/margin:\s*([^;]+)/.exec(rule)?.[1]?.split(/\s+/)[1]);
    expect(padding + margin).toBeCloseTo(0, 5);
  });

  it("sets nothing else that changes advance width", () => {
    // font-size, letter-spacing, font-weight, word-spacing and borders all
    // move the glyphs; only colour, background and radius are safe here.
    for (const property of [
      "font-size",
      "font-weight",
      "font-family",
      "letter-spacing",
      "word-spacing",
      "border-width",
      "border:",
      "transform",
    ]) {
      expect(rule).not.toContain(property);
    }
  });

  it("keeps the mirror and the textarea on one set of layout properties", () => {
    // Both inherit from the shared rule; a second declaration on either is how
    // they drift apart.
    expect(css).toContain(".hl-mirror,\n.hl textarea.hl-area {");
  });
});
