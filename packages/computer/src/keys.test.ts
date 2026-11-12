import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { hereProof, loadHostKey, loadLocalKey, publicKeyFromRaw, rawPublicKey, signText, verifyHere, verifyText } from "./keys.js";

describe("keys", () => {
  it("verify only the exact text, by the exact key", () => {
    const key = generateKeyPairSync("ed25519").privateKey;
    const other = generateKeyPairSync("ed25519").privateKey;
    const sig = signText(key, "kos-device/1|device|abc|dev_1");
    expect(verifyText(rawPublicKey(key), "kos-device/1|device|abc|dev_1", sig)).toBe(true);
    expect(verifyText(rawPublicKey(key), "kos-device/1|device|abd|dev_1", sig)).toBe(false);
    expect(verifyText(rawPublicKey(other), "kos-device/1|device|abc|dev_1", sig)).toBe(false);
    expect(verifyText(rawPublicKey(key), "kos-device/1|device|abc|dev_1", "c2hvcnQ=")).toBe(false);
    expect(publicKeyFromRaw("c2hvcnQ=")).toBeUndefined();
  });

  it("verify a signature CryptoKit made, as KOS for Mac signs its hello", () => {
    // Made once by Curve25519.Signing on macOS over this exact payload.
    const publicKey = "s84AWscKSp1OSNYFxq/ZgnaCmzCGF1Q3Y3H1sYGlCK0=";
    const signature = "arfmxHSwPBrHphS5bb4+FQ5K5zVJSrCFVZx2FPvsENBF9QfrHAgfnjv9IOwz+YrQYewuBAJgAskwXndmLS37CA==";
    expect(verifyText(publicKey, "kos-device/1|device|bm9uY2U=|dev_fixture", signature)).toBe(true);
    expect(verifyText(publicKey, "kos-device/1|device|bm9uY2U=|dev_other", signature)).toBe(false);
  });

  it("keep KOS's key in a file only the owner reads, and the same one next time", () => {
    const path = join(mkdtempSync(join(tmpdir(), "kos-keys-")), "nested", "device-host.key");
    const first = loadHostKey({ path });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadHostKey({ path }).publicKey).toBe(first.publicKey);
  });

  it("take the key from the environment when one is given", () => {
    const key = generateKeyPairSync("ed25519").privateKey;
    const env = key.export({ format: "der", type: "pkcs8" }).toString("base64");
    const loaded = loadHostKey({ env, path: "/nonexistent/never-written" });
    expect(loaded.publicKey).toBe(rawPublicKey(key));
  });
});

describe("the proof a device is on this computer", () => {
  it("is HMAC-SHA256 of KOS's nonce and the device id, the same in Swift (BuildsTests)", () => {
    const key = Buffer.alloc(32, 7);
    expect(hereProof(key, "bm9uY2U=", "dev_1")).toBe("DSnyF6p7ejzOZvXRYLSqCV1MlQQXTSs1ZKKIBztwwZ0=");
    expect(verifyHere(key, "bm9uY2U=", "dev_1", "DSnyF6p7ejzOZvXRYLSqCV1MlQQXTSs1ZKKIBztwwZ0=")).toBe(true);
    expect(verifyHere(key, "bm9uY2U=", "dev_2", "DSnyF6p7ejzOZvXRYLSqCV1MlQQXTSs1ZKKIBztwwZ0=")).toBe(false);
    expect(verifyHere(key, "bm9uY2U=", "dev_1", undefined)).toBe(false);
  });
});

describe("the secret of this computer", () => {
  it("is made once, readable by the owner alone, and the same when read again", () => {
    const path = join(mkdtempSync(join(tmpdir(), "local-key-")), "kos", "device-local.key");
    const key = loadLocalKey(path);
    expect(key).toHaveLength(32);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadLocalKey(path).equals(key)).toBe(true);
  });
});
