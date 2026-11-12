import { X509Certificate, createPublicKey } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { integer, loadLanCert, makeLanCert, oid, pinOf, time } from "./lancert.js";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("the Wi-Fi certificate", () => {
  it("is a self-signed P-256 certificate for KOS that verifies with its own key, for twenty years", () => {
    const at = Date.UTC(2026, 10, 12, 8, 0, 0);
    const made = makeLanCert(at);
    const cert = new X509Certificate(made.der);
    expect(cert.subject).toBe("CN=KOS");
    expect(cert.issuer).toBe("CN=KOS");
    expect(cert.verify(createPublicKey(made.key))).toBe(true);
    expect(cert.publicKey.asymmetricKeyDetails).toMatchObject({ namedCurve: "prime256v1" });
    expect(cert.ca).toBe(false);
    expect(cert.keyUsage).toEqual(["1.3.6.1.5.5.7.3.1"]);
    expect(new Date(cert.validFrom).getTime()).toBe(at - 86_400_000);
    expect(new Date(cert.validTo).getUTCFullYear()).toBe(2046);
    // The serial is positive: no leading byte with its high bit set.
    expect(Number.parseInt(cert.serialNumber.slice(0, 2), 16)).toBeLessThan(0x80);
  });

  it("pins by the SHA-256 of its DER, and says it in four groups of hex", () => {
    const made = makeLanCert(Date.now());
    expect(made.pin).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(made.words).toMatch(/^[0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4}$/);
    expect(Buffer.from(made.pin, "base64url").toString("hex").slice(0, 16).toUpperCase()).toBe(made.words.replaceAll(" ", ""));
    expect(pinOf(made.der)).toEqual({ pin: made.pin, words: made.words });
  });

  it("is made once and kept for the owner alone, the same one read back", () => {
    dir = mkdtempSync(join(tmpdir(), "kos-lan-"));
    const path = join(dir, "nested", "device-lan.pem");
    const first = loadLanCert(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const again = loadLanCert(path);
    expect(again.pin).toBe(first.pin);
    expect(readFileSync(path, "utf8")).toContain("BEGIN PRIVATE KEY");
  });

  it("refuses a kept file that holds no certificate, rather than making a new one", () => {
    dir = mkdtempSync(join(tmpdir(), "kos-lan-"));
    const path = join(dir, "device-lan.pem");
    writeFileSync(path, "nothing here");
    expect(() => loadLanCert(path)).toThrow(/private key and a certificate/);
    expect(readFileSync(path, "utf8")).toBe("nothing here");
  });
});

describe("its DER", () => {
  it("writes integers minimally and positive", () => {
    expect(integer(Buffer.from([0, 0, 5]))).toEqual(Buffer.from([0x02, 0x01, 0x05]));
    expect(integer(Buffer.from([0x80]))).toEqual(Buffer.from([0x02, 0x02, 0x00, 0x80]));
  });

  it("writes object identifiers in base 128", () => {
    // ecdsa-with-SHA256, as every certificate tool writes it.
    expect(oid("1.2.840.10045.4.3.2").toString("hex")).toBe("06082a8648ce3d040302");
  });

  it("writes UTCTime through 2049 and GeneralizedTime from 2050", () => {
    expect(time(new Date(Date.UTC(2049, 11, 31, 23, 59, 59))).toString("latin1")).toBe("\x17\x0d491231235959Z");
    expect(time(new Date(Date.UTC(2050, 0, 1, 0, 0, 0))).toString("latin1")).toBe("\x18\x0f20500101000000Z");
  });
});
