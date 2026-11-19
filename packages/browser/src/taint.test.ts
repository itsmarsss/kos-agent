import { describe, expect, it } from "vitest";

import { isDigitSlot, isSecretSlot, unechoed } from "./taint.js";

describe("what a tainted page hands back", () => {
  it("says every filled value as hidden where the page echoes it, a number however it is spaced", () => {
    const values = [
      { text: "pw-Canary-7f3k", digits: false },
      { text: "4242424242424242", digits: true },
    ];
    expect(unechoed("you typed pw-Canary-7f3k (pw-Canary-7f3k)", values)).toBe("you typed (hidden) ((hidden))");
    expect(unechoed("card 4242 4242 4242 4242 and 4242-4242-4242-4242", values)).toBe("card (hidden) and (hidden)");
    // A value a page could not echo exactly is left: regex characters in it are its own.
    expect(unechoed("a.b", [{ text: "a+b", digits: false }])).toBe("a.b");
    expect(unechoed("a+b", [{ text: "a+b", digits: false }])).toBe("(hidden)");
  });

  it("finds a value however an address or a script says it back: encoded, form-encoded, either hex case, as JSON", () => {
    const pw = `p@ss w0rd/&="q"+%~!'()\\`;
    const values = [{ text: pw, digits: false }];
    const said = [
      pw,
      encodeURIComponent(pw),
      encodeURIComponent(pw).replace(/%[0-9A-F]{2}/g, (h) => h.toLowerCase()),
      new URLSearchParams({ x: pw }).toString().slice(2),
      new URLSearchParams({ x: pw }).toString().slice(2).toLowerCase(),
      JSON.stringify(pw).slice(1, -1),
    ];
    for (const form of said) expect(unechoed(`sent ${form} back`, values)).toBe("sent (hidden) back");
  });

  it("looks for no value too short to stand for itself", () => {
    expect(unechoed("page 12 of 40", [{ text: "12", digits: true }])).toBe("page 12 of 40");
  });

  it("taints a password, a card's number and code, a token or a note; fills a username, a name or an address and leaves it be", () => {
    expect(["password", "card-number", "card-cvc", "card-expiry", "token", "text"].every((s) => isSecretSlot(s as never))).toBe(true);
    expect(["username", "card-name", "address-line1"].some((s) => isSecretSlot(s as never))).toBe(false);
    expect(isDigitSlot("card-number")).toBe(true);
    expect(isDigitSlot("password")).toBe(false);
  });
});
