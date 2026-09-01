import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Kernel } from "./kernel.js";
import { handleApiRequest } from "./server.js";
import { RETENTION_KEY } from "./session.js";

/**
 * Saving settings from the dashboard.
 *
 * The failure worth guarding is the quiet one: a request that carries nothing
 * usable must not be treated as a request to unset everything. Storing only
 * what a request contained reset the owner's saved retention to the defaults
 * on the next start, and the response still reported the old values because
 * they were still in memory.
 */
describe("saving settings", () => {
  let root: string;
  let kernel: Kernel;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-settings-"));
    kernel = await Kernel.boot({ rootDir: root });
  });

  afterEach(() => {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  });

  const post = (path: string, body: unknown) =>
    handleApiRequest(kernel, { method: "POST", path, body: body as never });

  describe("retention", () => {
    it("saves what it is given", async () => {
      const res = await post("/api/settings/retention", {
        maxChars: 64_000,
        maxExchanges: 20,
      });
      expect(res.status).toBe(200);
      expect(kernel.sessions.retention().maxChars).toBe(64_000);
      expect(kernel.sessions.retention().maxExchanges).toBe(20);
    });

    it("keeps the values a later request did not mention", async () => {
      await post("/api/settings/retention", { maxChars: 64_000, maxExchanges: 20 });
      await post("/api/settings/retention", { maxExchanges: 30 });
      const stored = kernel.settings.get<Record<string, number>>(RETENTION_KEY);
      expect(stored?.maxChars).toBe(64_000);
      expect(stored?.maxExchanges).toBe(30);
    });

    it("refuses a value that would retain nothing, and changes nothing", async () => {
      await post("/api/settings/retention", { maxChars: 64_000 });
      for (const bad of [{ maxChars: -5 }, { maxChars: 0 }, { maxExchanges: "abc" }]) {
        const res = await post("/api/settings/retention", bad);
        expect(res.status, JSON.stringify(bad)).toBe(400);
      }
      // The saved value is untouched by every one of those.
      expect(
        kernel.settings.get<Record<string, number>>(RETENTION_KEY)?.maxChars,
      ).toBe(64_000);
      expect(kernel.sessions.retention().maxChars).toBe(64_000);
    });
  });

  describe("profile", () => {
    it("saves a name and timezone", async () => {
      const res = await post("/api/settings/profile", {
        name: "Kenny",
        timezone: "America/Toronto",
      });
      expect(res.status).toBe(200);
      expect(kernel.profile.name).toBe("Kenny");
      expect(kernel.profile.timezone).toBe("America/Toronto");
    });

    /*
     * Checked against the runtime rather than a list. A timezone this machine
     * cannot resolve would make every schedule fire at the wrong hour, and
     * nothing would say so.
     */
    it("refuses a timezone this machine does not know", async () => {
      await post("/api/settings/profile", { name: "Kenny", timezone: "UTC" });
      const res = await post("/api/settings/profile", {
        name: "Kenny",
        timezone: "Mars/Olympus",
      });
      expect(res.status).toBe(400);
      expect(kernel.profile.timezone).toBe("UTC");
    });

    it("refuses an empty name rather than storing one", async () => {
      const res = await post("/api/settings/profile", { name: "  " });
      expect(res.status).toBe(400);
    });
  });
});
