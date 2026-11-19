import { describe, expect, it } from "vitest";

import { SIGNED_MEDIA_TTL_MS, SIGNED_URL_TTL_MS, SOCKET_TICKET_TTL_MS, signUrl, signedUrlValid, signingTtl } from "./signedurl.js";

const NOW = 1_800_000_000_000;
const sign = (url: string): string => signUrl(url, "s3cret", NOW)!.url;

describe("signed addresses", () => {
  it("are good for the exact address, with the token, until they lapse", () => {
    const signed = signUrl("/api/file/raw?path=a.png", "s3cret", NOW)!;
    expect(signed.url).toMatch(/^\/api\/file\/raw\?path=a\.png&kos_sig=\d+\.[\w-]+$/);
    expect(signed.expiresAt).toBe(NOW + SIGNED_URL_TTL_MS);
    expect(signed.url).not.toContain("s3cret");
    expect(signedUrlValid(signed.url, "s3cret", NOW + 1000)).toBe(true);
    expect(signedUrlValid(signed.url, "s3cret", NOW + SIGNED_URL_TTL_MS + 1)).toBe(false);
    expect(signedUrlValid(signed.url, "other", NOW)).toBe(false);
  });

  it("refuse an address changed after signing, or with no signature", () => {
    const url = sign("/api/file/raw?path=a.png");
    expect(signedUrlValid(url.replace("a.png", "b.png"), "s3cret", NOW)).toBe(false);
    expect(signedUrlValid(url.replace(/kos_sig=(\d+)/, (_m, e: string) => `kos_sig=${Number(e) + 60_000}`), "s3cret", NOW)).toBe(false);
    expect(signedUrlValid(`${url}&path=b.png`, "s3cret", NOW)).toBe(false);
    expect(signedUrlValid("/api/file/raw?path=a.png", "s3cret", NOW)).toBe(false);
  });

  it("are made only for the routes the dashboard points an element at, a player's and the socket's for their own time", () => {
    for (const url of ["/api/file/raw?path=a.png", "/api/file/view/a.pdf?path=a.pdf", "/api/file/view?path=a.pdf", "/api/file/media?path=a.mp4", "/api/artifacts/p%201/thumb?theme=dark&v=3", "/api/approvals/7/picture", "/api/frames/f1", "/api/socket"]) {
      expect(signedUrlValid(sign(url), "s3cret", NOW)).toBe(true);
    }
    expect(signingTtl("/api/file/media?path=a.mp4")).toBe(SIGNED_MEDIA_TTL_MS);
    expect(signingTtl("/api/file/view/a.pdf?path=a.pdf")).toBe(SIGNED_MEDIA_TTL_MS);
    expect(signingTtl("/api/socket")).toBe(SOCKET_TICKET_TTL_MS);
    for (const url of ["/api/status", "/api/secrets", "/api/file?path=a.txt", "/api/sign?url=/api/file/raw", "/api/file/raw/x", "/api/approvals/7/picture/x", "/api/artifacts/a/b/thumb"]) {
      expect(signUrl(url, "s3cret", NOW)).toBeUndefined();
    }
  });

  it("open no route that is never signed, even with a signature made by the same key", () => {
    // What a signer would have made for /api/status, had it signed it: still refused.
    const raw = sign("/api/file/raw?path=a.png");
    const forged = raw.replace("/api/file/raw?path=a.png", "/api/status");
    expect(signedUrlValid(forged, "s3cret", NOW)).toBe(false);
  });
});
