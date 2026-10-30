import { describe, expect, it } from "vitest";

import { KEEP_DAYS, keptSessionCookies } from "./cookies.js";
import { stepsOf, urlFor } from "./hands.js";
import { parseKeys } from "./keys.js";
import { parseStep, touchesPage } from "./steps.js";

describe("a run of steps", () => {
  it("takes each gesture in its one shape, with the older selector key still read", () => {
    expect(parseStep({ click: " @e4 " }, 0)).toEqual({ click: "@e4" });
    expect(parseStep({ fill: { target: "#q", text: "shoes" } }, 0)).toEqual({ fill: { target: "#q", text: "shoes" } });
    expect(parseStep({ fill: { selector: "#q", text: "" } }, 0)).toEqual({ fill: { target: "#q", text: "" } });
    expect(parseStep({ select: { target: "@e2", value: "Toronto" } }, 0)).toEqual({ select: { target: "@e2", values: ["Toronto"] } });
    expect(parseStep({ wait: { text: "Saved" } }, 0)).toEqual({ wait: { text: "Saved" } });
    expect(parseStep({ wait: 500 }, 0)).toEqual({ wait: 500 });
    expect(parseStep({ dialog: "accept" }, 0)).toEqual({ dialog: { accept: true } });
    expect(parseStep({ dialog: { accept: true, text: "yes" } }, 0)).toEqual({ dialog: { accept: true, text: "yes" } });
    expect(parseStep({ go: "back" }, 0)).toEqual({ go: "back" });
  });

  it("refuses a malformed step, saying which", () => {
    expect(() => parseStep({ click: "a", fill: "b" }, 2)).toThrow(/step 3: must have exactly one/);
    expect(() => parseStep({ fill: { target: "#q" } }, 0)).toThrow(/fill wants \{target, text\}/);
    expect(() => parseStep({ wait: 60_000 }, 0)).toThrow(/up to 30000/);
    expect(() => parseStep({ go: "sideways" }, 0)).toThrow(/go wants/);
    expect(() => stepsOf([])).toThrow(/steps required/);
    expect(() => stepsOf(Array.from({ length: 21 }, () => ({ wait: 1 })))).toThrow(/at most 20/);
  });

  it("asks only when a step does something to the page, and when a step cannot be read", () => {
    expect(touchesPage({ steps: [{ open: "https://a" }, { scroll: "down" }, { wait: 100 }, { hover: "@e1" }, { go: "back" }] })).toBe(false);
    expect(touchesPage({ steps: [{ wait: 100 }, { click: "@e1" }] })).toBe(true);
    expect(touchesPage({ steps: [{ wait: 100, click: "@e1" }] })).toBe(true);
    expect(touchesPage({ steps: [] })).toBe(true);
  });
});

describe("an address", () => {
  it("is made a url the way an address bar would, and kept to the web", () => {
    expect(urlFor("example.com/a")).toBe("https://example.com/a");
    expect(urlFor("localhost:4317")).toBe("http://localhost:4317");
    expect(urlFor("127.0.0.1:8080/x")).toBe("http://127.0.0.1:8080/x");
    expect(urlFor("https://example.com")).toBe("https://example.com");
    expect(urlFor("about:blank")).toBe("about:blank");
    expect(() => urlFor("file:///etc/passwd")).toThrow(/file: addresses are not opened/);
    expect(() => urlFor("chrome://settings")).toThrow(/not opened/);
    expect(() => urlFor("view-source:https://example.com")).toThrow(/not opened/);
    expect(() => urlFor("best shoes")).toThrow(/not an address/);
  });
});

describe("a key press", () => {
  it("is the key Chrome wants, with its modifiers and what it types", () => {
    expect(parseKeys("Enter")).toMatchObject({ key: "Enter", keyCode: 13, text: "\r", modifiers: 0 });
    expect(parseKeys("Shift+Tab")).toMatchObject({ key: "Tab", modifiers: 8, held: [{ key: "Shift" }] });
    expect(parseKeys("a")).toMatchObject({ key: "a", code: "KeyA", keyCode: 65, text: "a" });
    expect(parseKeys("Shift+a")).toMatchObject({ key: "A", text: "A" });
    expect(parseKeys("F5")).toMatchObject({ key: "F5", keyCode: 116 });
    expect(parseKeys("Shift++")).toMatchObject({ key: "+", modifiers: 8 });
  });

  it("sends an editing shortcut as the command it is, typing nothing", () => {
    expect(parseKeys("Meta+a")).toMatchObject({ modifiers: 4, commands: ["selectAll"] });
    expect(parseKeys("Control+v").commands).toEqual(["paste"]);
    expect(parseKeys("Meta+Shift+z").commands).toEqual(["redo"]);
    expect(parseKeys("Meta+a").text).toBeUndefined();
  });

  it("refuses a key or modifier it does not know", () => {
    expect(() => parseKeys("Hyper+a")).toThrow(/unknown modifier "Hyper"/);
    expect(() => parseKeys("Launch")).toThrow(/unknown key "Launch"/);
  });
});

describe("keeping sign-ins", () => {
  it("gives each session cookie an expiry, keeping everything else about it, and leaves the rest alone", () => {
    const now = 1_800_000_000_000;
    const kept = keptSessionCookies(
      [
        { name: "sid", value: "s", domain: ".shop.example", path: "/", secure: true, httpOnly: true, session: true, sameSite: "Lax", priority: "Medium", sourceScheme: "Secure", sourcePort: 443 },
        { name: "pref", value: "p", domain: "shop.example", path: "/", secure: false, httpOnly: false, session: false },
      ],
      now,
    );
    expect(kept).toEqual([
      { name: "sid", value: "s", domain: ".shop.example", path: "/", secure: true, httpOnly: true, sameSite: "Lax", priority: "Medium", sourceScheme: "Secure", sourcePort: 443, expires: now / 1000 + KEEP_DAYS * 86_400 },
    ]);
  });
});
