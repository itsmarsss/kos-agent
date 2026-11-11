import { describe, expect, it } from "vitest";

import { GUARD_SCRIPT, RTC_GUARD, pageDocument, splitHtml } from "./artifactdoc.js";

describe("a page's own head and body", () => {
  it("splits a whole document and passes a fragment through", () => {
    expect(splitHtml('<!doctype html><html lang="en"><head><style>p{}</style></head><body class="x"><p>a</p></body></html>')).toEqual({ head: "<style>p{}</style>", body: "<p>a</p>" });
    expect(splitHtml("<h1>Hi</h1><p>a</p>")).toEqual({ head: "", body: "<h1>Hi</h1><p>a</p>" });
    expect(splitHtml("<header><h1>Hi</h1></header><body><p>a</p>")).toEqual({ head: "", body: "<p>a</p>" });
  });

  it("reads no tag inside a script, a style or a comment", () => {
    const script = '<script>var t = "<head></head><body>x</body></html>";</script>';
    expect(splitHtml(`<h1>Hi</h1>${script}<p>after</p>`)).toEqual({ head: "", body: `<h1>Hi</h1>${script}<p>after</p>` });
    expect(splitHtml(`<head><script>document.write("</head><body>")</script></head><body><p>a</p></body>`)).toEqual({ head: '<script>document.write("</head><body>")</script>', body: "<p>a</p>" });
    expect(splitHtml(`<!-- <body>not</body> --><style>a::after{content:"<html>"}</style><p>b</p>`)).toEqual({ head: "", body: `<!-- <body>not</body> --><style>a::after{content:"<html>"}</style><p>b</p>` });
  });
});

describe("WebRTC, taken away", () => {
  it("whatever else the browser has, and for good", () => {
    const fake: Record<string, unknown> = { RTCPeerConnection: class {}, webkitRTCPeerConnection: class {}, RTCDataChannel: class {} };
    new Function("window", RTC_GUARD)(fake);
    expect(fake.RTCPeerConnection).toBeUndefined();
    expect(fake.webkitRTCPeerConnection).toBeUndefined();
    expect(() => (fake.RTCPeerConnection = class {})).toThrow(/read only/);
    expect(fake.RTCPeerConnection).toBeUndefined();
  });

  it("before the guard in every frame the dashboard builds", () => {
    const doc = pageDocument({ html: "<p>a</p>", tokens: {}, mode: "dark", css: "", libraries: [] });
    expect(doc.indexOf(RTC_GUARD)).toBeGreaterThan(0);
    expect(doc.indexOf(RTC_GUARD)).toBeLessThan(doc.indexOf(GUARD_SCRIPT));
  });
});

describe("the bridge's own helpers", () => {
  it("binds the colour reader to the name the bridge calls, whatever a minified build names the function", () => {
    const doc = pageDocument({ html: "<p>x</p>", tokens: {}, mode: "dark", css: "", libraries: [] });
    expect(doc).toMatch(/var colourOf=function/);
    expect(doc).toContain("colourOf(bs.backgroundColor)");
  });
});
