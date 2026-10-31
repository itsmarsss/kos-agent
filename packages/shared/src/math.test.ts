import { describe, expect, it } from "vitest";

import { displayMathAt, MATH, mathOf, type MathSource } from "./math.js";

function first(text: string): (MathSource & { at: number }) | undefined {
  const m = MATH.exec(text);
  return m ? { ...mathOf(m), at: m.index } : undefined;
}

describe("math in a line", () => {
  it("finds each way of writing it", () => {
    expect(first("so $x^2 + 1$ is")).toEqual({ tex: "x^2 + 1", display: false, at: 3 });
    expect(first("by \\(\\frac{a}{b}\\) here")).toEqual({ tex: "\\frac{a}{b}", display: false, at: 3 });
    expect(first("$$\\int_0^1 x\\,dx$$")).toEqual({ tex: "\\int_0^1 x\\,dx", display: true, at: 0 });
    expect(first("then \\[ e^{i\\pi} = -1 \\]")).toEqual({ tex: "e^{i\\pi} = -1", display: true, at: 5 });
  });

  it("leaves prices as prices", () => {
    for (const text of ["it was $5 and then $10", "from $3-$4 a unit", "$1,000 to $2,000", "I paid $5. You paid $6.", "US$5 or US$6", "a lone $ sign"]) {
      expect(first(text), text).toBeUndefined();
    }
    // Not from the price into the code span; the span itself is the renderer's to keep.
    expect(first("$10, not `$y$`")?.at).toBe(10);
  });

  it("keeps an escaped dollar inside math, and does not open on one", () => {
    expect(first("costs $\\$5 + x$ total")?.tex).toBe("\\$5 + x");
    expect(first("a \\$5 note and a \\$6 one")).toBeUndefined();
  });

  it("does not run across lines", () => {
    expect(first("$a\nb$")).toBeUndefined();
  });
});

describe("display math on lines of its own", () => {
  it("spans the lines between its fences", () => {
    const lines = ["before", "$$", "a = b", "+ c", "$$", "after"];
    expect(displayMathAt(lines, 0)).toBeUndefined();
    expect(displayMathAt(lines, 1)).toEqual({ tex: "a = b\n+ c", next: 5 });
    expect(displayMathAt(["\\[", "x", "\\]"], 0)).toEqual({ tex: "x", next: 3 });
    expect(displayMathAt(["$$ a +", "b $$"], 0)).toEqual({ tex: "a +\nb", next: 2 });
  });

  it("takes a whole line of it, but not one with words after", () => {
    expect(displayMathAt(["$$x^2$$"], 0)).toEqual({ tex: "x^2", next: 1 });
    expect(displayMathAt(["$$x$$ and $$y$$"], 0)).toBeUndefined();
    expect(displayMathAt(["$$", "x$$ then words"], 0)).toBeUndefined();
  });

  it("is not math when it never closes", () => {
    expect(displayMathAt(["$$", "x", "y"], 0)).toBeUndefined();
  });
});
