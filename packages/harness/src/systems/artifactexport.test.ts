import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ArtifactExporter, ExportRefusal, ExportUnavailable } from "./artifactexport.js";

/** The exporter's answers when its Chrome cannot be had, with no Chrome started. */
describe("an export whose Chrome does not come", () => {
  let dist: string;

  beforeEach(() => {
    // The dashboard's build of the frame, as a test's own: the kit's sheet, tokens and a stand-in for each runtime.
    dist = mkdtempSync(join(tmpdir(), "kos-export-"));
    mkdirSync(join(dist, "fonts"), { recursive: true });
    writeFileSync(join(dist, "frame.css"), "body{margin:0}");
    writeFileSync(join(dist, "tokens.json"), JSON.stringify({ dark: { "--bg": "#0c0e12" }, light: { "--bg": "#f4f5f8" } }));
    for (const runtime of ["kos-doc", "kos-deck", "kos-sheet"]) writeFileSync(join(dist, `${runtime}.js`), `/* ${runtime} */`);
  });
  afterEach(() => rmSync(dist, { recursive: true, force: true }));

  const failing = (message: string): ArtifactExporter =>
    new ArtifactExporter({
      load: () => ({ page: { id: "brief", kind: "doc", title: "Brief", html: "<article data-doc><h1>Brief</h1></article>" }, title: "Brief" }),
      call: async () => ({ rows: [] }),
      browser: () => Promise.reject(new Error(message)),
      pageLib: () => dist,
    });

  it("says to try again when the Chrome started too slowly to answer, not a server error", async () => {
    const err = await failing("Chrome did not answer on its port in time").export("brief", "pdf").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExportRefusal);
    expect(err).not.toBeInstanceOf(ExportUnavailable);
    expect((err as Error).message).toBe("KOS's Chrome did not start in time, so there is nothing to export; try again");
  });

  it("still says there is no Chrome where none is found, and passes on what it cannot name", async () => {
    await expect(failing("no Chrome found; name its path under Settings > Browser").export("brief", "pdf")).rejects.toBeInstanceOf(ExportUnavailable);
    const other = await failing("something else").export("brief", "pdf").catch((e: unknown) => e);
    expect(other).not.toBeInstanceOf(ExportRefusal);
  });
});
