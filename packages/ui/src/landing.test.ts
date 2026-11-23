// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { landOnHeading } from "./landing.js";
import { pageTitle } from "./routes.js";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("arriving on a page", () => {
  it("lands on the page's heading, which takes the focus by script only", () => {
    document.body.innerHTML = `<main data-focus-home tabindex="-1"><div class="ops-page"><h1>Inbox</h1><button>Approve</button></div></main>`;
    landOnHeading();
    const h1 = document.querySelector("h1")!;
    expect(document.activeElement).toBe(h1);
    expect(h1.tabIndex).toBe(-1);
  });

  it("lands on the page's region while it has no heading", () => {
    document.body.innerHTML = `<main data-focus-home tabindex="-1"><div class="ops-page"></div></main>`;
    landOnHeading();
    expect(document.activeElement).toBe(document.querySelector("main"));
  });
});

describe("a page's title", () => {
  it("names the page, or the one thing it shows, then KOS", () => {
    expect(pageTitle({ name: "inbox" })).toBe("Inbox · KOS");
    expect(pageTitle({ name: "crons" })).toBe("Schedule · KOS");
    expect(pageTitle({ name: "chats", id: "c1" }, "Lisbon weekend")).toBe("Lisbon weekend · KOS");
    expect(pageTitle({ name: "chats", id: "c1" }, "  ")).toBe("Chats · KOS");
  });
});
