import { describe, expect, it } from "vitest";

import { splitHtml } from "./artifactdoc.js";

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
