// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { repeatedTitle } from "./runtime.js";

const body = (html: string): HTMLElement => {
  document.body.innerHTML = html;
  return document.body;
};

describe("the heading a phone's bar already shows", () => {
  it("is the first heading, an h1 saying the title, however it is spaced or cased", () => {
    expect(repeatedTitle(body('<p class="kicker">Garden</p><h1>Beds for  the\nnew season</h1><h2>Where</h2>'), "Beds for the New Season")?.tagName).toBe("H1");
  });

  it("is none for other words, a heading after another, or no title", () => {
    expect(repeatedTitle(body("<h1>Garden costs, spring</h1>"), "Garden costs")).toBeUndefined();
    expect(repeatedTitle(body("<h2>Plan</h2><h1>Plan</h1>"), "Plan")).toBeUndefined();
    expect(repeatedTitle(body("<h1></h1>"), "")).toBeUndefined();
  });
});
