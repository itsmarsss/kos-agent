import { describe, expect, it } from "vitest";

import { template, templateArgs } from "./templating.js";

describe("template", () => {
  it("substitutes flat variables", () => {
    expect(template("spent {total} on {n} buys", { total: "$40.00", n: 3 })).toBe(
      "spent $40.00 on 3 buys",
    );
  });

  it("uses the fallback for null or missing values", () => {
    expect(template("hi {name}", { name: null }, "there")).toBe("hi there");
    expect(template("hi {name}", {}, "there")).toBe("hi there");
  });

  it("leaves non-brace text untouched", () => {
    expect(template("no vars here", { a: 1 })).toBe("no vars here");
  });
});

describe("templateArgs", () => {
  it("templates string args and passes others through", () => {
    const out = templateArgs(
      { text: "you spent {total}", limit: 200 },
      { total: "$40.00" },
    );
    expect(out).toEqual({ text: "you spent $40.00", limit: 200 });
  });
});
