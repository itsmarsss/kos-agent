import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * The certificate the Wi-Fi listener serves TLS with.
 *
 * A phone on the home network reaches KOS at an address no public
 * authority will vouch for, so KOS makes its own: an ECDSA P-256 key and a
 * self-signed certificate, made once and kept outside the workspace with
 * the device host key. A phone never validates it; it pins it, by the
 * SHA-256 of its DER, which the pairing link carries (`pin`) and the
 * dashboard shows as words to check when the address is typed instead.
 *
 * Node can parse a certificate but not make one, so the few DER structures
 * an X.509 v3 certificate needs are written here.
 */

export interface LanCert {
  /** The private key, PKCS#8 PEM, for the TLS server. */
  key: string;
  /** The certificate, PEM. */
  cert: string;
  /** The certificate's DER, what the pin is taken over. */
  der: Buffer;
  /** SHA-256 of the DER, base64url without padding: what a phone pins. */
  pin: string;
  /** The first 16 hex digits of that hash, in four groups: what the owner compares by eye. */
  words: string;
}

/** The pin and the words for a certificate's DER. */
export function pinOf(der: Buffer): { pin: string; words: string } {
  const hash = createHash("sha256").update(der).digest();
  const hex = hash.toString("hex").slice(0, 16).toUpperCase();
  return { pin: hash.toString("base64url"), words: hex.match(/.{4}/g)!.join(" ") };
}

/** KOS's own folder outside the workspace, where the certificate is kept unless the host says otherwise. */
export const KOS_HOME = join(homedir(), ".kos");

/**
 * The certificate kept at `path`, made there on first use with only the
 * owner able to read it. A file that does not hold both a key and a
 * certificate is an error, never silently replaced: a new certificate means
 * every phone pairs again.
 *
 * Only a folder this made, or KOS's own (`home`), is narrowed to the owner;
 * any other the host names is the owner's to keep, and one others can write
 * to is refused, since they could put another certificate in its place.
 */
export function loadLanCert(path: string, now: () => number = Date.now, home: string = KOS_HOME): LanCert {
  const dir = dirname(path);
  const made = mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (made === undefined) {
    if (resolve(dir) === resolve(home)) ownerOnly(dir, 0o700);
    else if (statSync(dir).mode & 0o022) throw new Error(`others can write to ${dir}: keep the Wi-Fi certificate in a folder only you can`);
  }
  if (existsSync(path)) return readKept(path);
  const fresh = makeLanCert(now());
  try {
    writeFileSync(path, `${fresh.key}${fresh.cert}`, { mode: 0o600, flag: "wx" });
  } catch (err) {
    // Made meanwhile, by another KOS starting at once: that one is kept, as any is.
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return readKept(path);
    throw err;
  }
  ownerOnly(path, 0o600);
  return fresh;
}

/** The kept file, narrowed to the owner first if others could read it. */
function readKept(path: string): LanCert {
  ownerOnly(path, 0o600);
  return readLanCert(readFileSync(path, "utf8"));
}

/** Narrows a path to `mode` when others can reach it; never widens it. */
function ownerOnly(path: string, mode: number): void {
  if (statSync(path).mode & 0o077) chmodSync(path, mode);
}

/** A key and certificate from one PEM file. */
export function readLanCert(pem: string): LanCert {
  const key = pem.match(/-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----\n?/)?.[0];
  const cert = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----\n?/)?.[0];
  if (!key || !cert) throw new Error("the Wi-Fi certificate file must hold a private key and a certificate");
  const der = Buffer.from(cert.replace(/-----[A-Z ]+-----|\s/g, ""), "base64");
  return { key, cert, der, ...pinOf(der) };
}

const YEARS = 20;
const DAY_MS = 86_400_000;

/** A fresh key and a certificate for it, valid from a day before `at` for twenty years. */
export function makeLanCert(at: number): LanCert {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const notBefore = new Date(at - DAY_MS);
  const notAfter = new Date(at);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + YEARS);
  const der = selfSigned(privateKey, notBefore, notAfter);
  const key = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const cert = `-----BEGIN CERTIFICATE-----\n${der.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;
  // Read back as any loaded one is, so a made certificate and a kept one are the same thing.
  return readLanCert(`${key}${cert}`);
}

// The OIDs a certificate of this shape names.
const OID = {
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
  commonName: "2.5.4.3",
  basicConstraints: "2.5.29.19",
  keyUsage: "2.5.29.15",
  extKeyUsage: "2.5.29.37",
  serverAuth: "1.3.6.1.5.5.7.3.1",
};

function selfSigned(key: KeyObject, notBefore: Date, notAfter: Date): Buffer {
  const algorithm = seq(oid(OID.ecdsaWithSha256));
  const name = seq(set(seq(oid(OID.commonName), utf8("KOS"))));
  const serial = randomBytes(16);
  // Positive, and sixteen bytes long: the top bit clear, the next one set.
  serial[0] = (serial[0]! & 0x7f) | 0x40;
  const spki = createPublicKey(key).export({ format: "der", type: "spki" });
  const extensions = seq(
    extension(OID.basicConstraints, true, seq()),
    // digitalSignature alone: bit 0, so one byte with seven bits unused.
    extension(OID.keyUsage, true, tlv(0x03, Buffer.from([0x07, 0x80]))),
    extension(OID.extKeyUsage, false, seq(oid(OID.serverAuth))),
  );
  const tbs = seq(
    tlv(0xa0, integer(Buffer.from([2]))),
    integer(serial),
    algorithm,
    name,
    seq(time(notBefore), time(notAfter)),
    name,
    spki,
    tlv(0xa3, extensions),
  );
  const signature = sign("sha256", tbs, { key, dsaEncoding: "der" });
  return seq(tbs, algorithm, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
}

// DER, as little of it as a certificate needs.

function tlv(tag: number, content: Buffer): Buffer {
  const n = content.length;
  const length = n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]);
  if (n > 0xffff) throw new Error("DER value too long");
  return Buffer.concat([Buffer.from([tag]), length, content]);
}

const seq = (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]): Buffer => tlv(0x31, Buffer.concat(items));
const utf8 = (text: string): Buffer => tlv(0x0c, Buffer.from(text, "utf8"));

/** A non-negative INTEGER from its big-endian bytes, a zero byte before a high bit. */
export function integer(bytes: Buffer): Buffer {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  const trimmed = bytes.subarray(i);
  return tlv(0x02, trimmed[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed);
}

/** An OBJECT IDENTIFIER: the first two arcs as one byte, each other in base 128. */
export function oid(dotted: string): Buffer {
  const arcs = dotted.split(".").map(Number);
  const out = [40 * arcs[0]! + arcs[1]!];
  for (const arc of arcs.slice(2)) {
    const groups = [arc & 0x7f];
    for (let v = arc >>> 7; v > 0; v >>>= 7) groups.unshift((v & 0x7f) | 0x80);
    out.push(...groups);
  }
  return tlv(0x06, Buffer.from(out));
}

/** UTCTime through 2049, GeneralizedTime from 2050, as RFC 5280 asks; to the second, in UTC. */
export function time(at: Date): Buffer {
  const iso = at.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const year = at.getUTCFullYear();
  return year < 2050 ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`, "ascii")) : tlv(0x18, Buffer.from(`${iso}Z`, "ascii"));
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return seq(oid(id), ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []), tlv(0x04, value));
}
