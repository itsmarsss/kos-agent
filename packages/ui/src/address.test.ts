import { describe, expect, it } from "vitest";

import { tabName, toAddress } from "./address.js";

const SEARCH = "https://duckduckgo.com/?q=%s";

describe("the address bar", () => {
  it("sends an address where it says and words to the search", () => {
    expect(toAddress("https://example.com/a?b=1", SEARCH)).toBe("https://example.com/a?b=1");
    expect(toAddress("chrome://extensions", SEARCH)).toBe("chrome://extensions");
    expect(toAddress("example.com", SEARCH)).toBe("https://example.com");
    expect(toAddress("news.ycombinator.com/newest", SEARCH)).toBe("https://news.ycombinator.com/newest");
    expect(toAddress("localhost:4317", SEARCH)).toBe("http://localhost:4317");
    expect(toAddress("127.0.0.1:4317/settings", SEARCH)).toBe("http://127.0.0.1:4317/settings");
    expect(toAddress("about:blank", SEARCH)).toBe("about:blank");
    expect(toAddress("time: now", SEARCH)).toBe("https://duckduckgo.com/?q=time%3A%20now");
    expect(toAddress("best pizza near me", SEARCH)).toBe("https://duckduckgo.com/?q=best%20pizza%20near%20me");
    expect(toAddress("what is example.com", SEARCH)).toBe("https://duckduckgo.com/?q=what%20is%20example.com");
    expect(toAddress("kos", SEARCH)).toBe("https://duckduckgo.com/?q=kos");
    expect(toAddress("   ", SEARCH)).toBe("");
  });

  it("names a tab by its title, else its host", () => {
    expect(tabName({ title: "Hacker News", url: "https://news.ycombinator.com/" })).toBe("Hacker News");
    expect(tabName({ title: "", url: "https://example.com/x" })).toBe("example.com");
    expect(tabName({ title: "", url: "about:blank" })).toBe("blank tab");
  });
});
