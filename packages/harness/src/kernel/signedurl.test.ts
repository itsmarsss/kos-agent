import { describe, expect, it } from "vitest";

import { SIGNED_URL_TTL_MS, signUrl, signedUrlValid } from "./signedurl.js";

const NOW = 1_800_000_000_000;

describe("signed addresses", () => {
  it("are good for the exact address, with the token, until they lapse", () => {
    const url = signUrl("/api/file/media?path=a.mp4", "s3cret", NOW);
    expect(url).toMatch(/^\/api\/file\/media\?path=a\.mp4&kos_sig=\d+\.[\w-]+$/);
    expect(url).not.toContain("s3cret");
    expect(signedUrlValid(url, "s3cret", NOW + 1000)).toBe(true);
    expect(signedUrlValid(url, "s3cret", NOW + SIGNED_URL_TTL_MS + 1)).toBe(false);
    expect(signedUrlValid(url, "other", NOW)).toBe(false);
  });

  it("refuse an address changed after signing, or with no signature", () => {
    const url = signUrl("/api/file/raw?path=a.png", "s3cret", NOW);
    expect(signedUrlValid(url.replace("a.png", "b.png"), "s3cret", NOW)).toBe(false);
    expect(signedUrlValid(url.replace(/kos_sig=(\d+)/, (_m, e: string) => `kos_sig=${Number(e) + 60_000}`), "s3cret", NOW)).toBe(false);
    expect(signedUrlValid(`${url}&path=b.png`, "s3cret", NOW)).toBe(false);
    expect(signedUrlValid("/api/file/raw?path=a.png", "s3cret", NOW)).toBe(false);
    expect(signedUrlValid(signUrl("/api/approvals/3/picture", "s3cret", NOW), "s3cret", NOW)).toBe(true);
  });
});
