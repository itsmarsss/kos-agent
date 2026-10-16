import { describe, expect, it } from "vitest";

import { downloadsFolder, safeName, settleDownload, uniquePath } from "./downloads.js";

/**
 * A finished download lands with its project under the name the site gave
 * it, made safe, never over something that is already there.
 */
describe("settling a download", () => {
  it("names the file safely and the folder by the project", () => {
    expect(safeName("report.pdf")).toBe("report.pdf");
    expect(safeName("../../etc/passwd")).toBe("passwd");
    expect(safeName('bad:name?.txt')).toBe("bad_name_.txt");
    expect(safeName("")).toBe("download");
    expect(downloadsFolder("garden")).toBe("projects/garden/downloads");
    expect(downloadsFolder(null)).toBe("downloads");
  });

  it("finds a name nothing has yet", () => {
    const taken = new Set(["/w/d/report.pdf", "/w/d/report (2).pdf"]);
    expect(uniquePath("/w/d", "report.pdf", (p) => taken.has(p))).toBe("/w/d/report (3).pdf");
    expect(uniquePath("/w/d", "fresh.csv", (p) => taken.has(p))).toBe("/w/d/fresh.csv");
  });

  it("moves the staged file into the project's downloads and says where", () => {
    const moves: [string, string][] = [];
    const made: string[] = [];
    const result = settleDownload(
      { workspaceRoot: "/w", stagingPath: "/w/.kos/browser-downloads/abc-guid", suggestedFilename: "Q3 report.pdf", projectSlug: "finance" },
      { exists: (p) => p === "/w/.kos/browser-downloads/abc-guid", mkdir: (p) => made.push(p), rename: (a, b) => moves.push([a, b]) },
    );
    expect(result).toEqual({ path: "projects/finance/downloads/Q3 report.pdf", name: "Q3 report.pdf" });
    expect(made).toEqual(["/w/projects/finance/downloads"]);
    expect(moves).toEqual([["/w/.kos/browser-downloads/abc-guid", "/w/projects/finance/downloads/Q3 report.pdf"]]);
    expect(() => settleDownload({ workspaceRoot: "/w", stagingPath: "/w/.kos/browser-downloads/nope", suggestedFilename: "x", projectSlug: null }, { exists: () => false })).toThrow(/not found/);
  });
});
