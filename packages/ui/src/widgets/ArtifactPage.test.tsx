// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { api, type PageSummary } from "../api.js";
import { ArtifactPage } from "./ArtifactPage.js";
import { PAGE_CSP, pageDocument, splitHtml } from "./artifactdoc.js";

beforeAll(() => {
  // jsdom has no media queries; the frame only listens for the theme changing.
  window.matchMedia ??= (() => ({ addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const record: PageSummary = { id: "budget", projectSlug: "budget", title: "Budget", path: "x", updatedAt: 1, kind: "html" };

describe("an HTML page's document", () => {
  it("puts the no-network policy first, before anything the page wrote", () => {
    const doc = pageDocument({ html: "<head><title>t</title></head><body><p>hi</p></body>", tokens: { "--bg": "#000" }, mode: "dark", css: "", libraries: [] });
    const policy = doc.indexOf("Content-Security-Policy");
    expect(policy).toBeGreaterThan(0);
    expect(policy).toBeLessThan(doc.indexOf("<title>t</title>"));
    expect(policy).toBeLessThan(doc.indexOf("window,\"kos\""));
    expect(PAGE_CSP).toContain("connect-src 'none'");
    expect(PAGE_CSP).toContain("default-src 'none'");
    expect(PAGE_CSP).not.toMatch(/https?:/);
  });

  it("takes a whole document or a fragment", () => {
    expect(splitHtml("<!doctype html><html><head><style>a{}</style></head><body class=x><p>b</p></body></html>")).toEqual({ head: "<style>a{}</style>", body: "<p>b</p>" });
    expect(splitHtml("<p>just this</p>")).toEqual({ head: "", body: "<p>just this</p>" });
  });

  it("keeps a library's text from closing its script early", () => {
    const doc = pageDocument({ html: "<p>", tokens: {}, mode: "light", css: "", libraries: ["var s='</script><img src=x>';"] });
    expect(doc).toContain("'<\\/script><img src=x>'");
  });
});

describe("the page's frame", () => {
  const page = { id: "budget", title: "Budget", html: "<p>hi</p>", capabilities: { ask: true } };

  async function frame(): Promise<HTMLIFrameElement> {
    render(<ArtifactPage record={record} page={page} />);
    return (await waitFor(() => screen.getByTitle("Budget"))) as HTMLIFrameElement;
  }

  it("runs scripts on an opaque origin: sandboxed without allow-same-origin", async () => {
    const el = await frame();
    expect(el.getAttribute("sandbox")).toBe("allow-scripts");
    expect(el.getAttribute("srcdoc")).toContain("<p>hi</p>");
  });

  it("relays its own frame's calls to the server and ignores anyone else's", async () => {
    const call = vi.spyOn(api, "pageCall").mockResolvedValue({ rows: [] });
    const el = await frame();
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { source: window, data: { __kos: "call", id: 1, method: "query", args: { sql: "SELECT 1" } } }));
    });
    expect(call).not.toHaveBeenCalled();
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { source: el.contentWindow, data: { __kos: "call", id: 2, method: "query", args: { sql: "SELECT 1" } } }));
    });
    expect(call).toHaveBeenCalledWith("budget", "query", { sql: "SELECT 1" });
  });

  it("asks the owner before a page sends anything to the chat", async () => {
    const sent = vi.spyOn(api, "message").mockResolvedValue({ reply: "" } as never);
    const el = await frame();
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { source: el.contentWindow, data: { __kos: "call", id: 3, method: "ask", args: { text: "add a column" } } }));
    });
    expect(sent).not.toHaveBeenCalled();
    expect(screen.getByText("add a column")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(sent).toHaveBeenCalledWith("add a column", "project:budget");
  });

  it("shows a page's error with a way to ask KOS to fix it", async () => {
    const sent = vi.spyOn(api, "message").mockResolvedValue({ reply: "" } as never);
    const el = await frame();
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { source: el.contentWindow, data: { __kos: "error", message: "x is not defined" } }));
    });
    expect(screen.getByRole("alert").textContent).toContain("x is not defined");
    fireEvent.click(screen.getByRole("button", { name: "Fix with KOS" }));
    expect(sent.mock.calls[0]?.[0]).toMatch(/x is not defined.*pages\.get/);
    expect(sent.mock.calls[0]?.[1]).toBe("project:budget");
  });

  it("stops a page that sends its frame somewhere else", async () => {
    const el = await frame();
    fireEvent.load(el);
    fireEvent.load(el);
    expect(screen.getByRole("alert").textContent).toMatch(/tried to leave KOS/);
    expect(screen.queryByTitle("Budget")).toBeNull();
  });
});
