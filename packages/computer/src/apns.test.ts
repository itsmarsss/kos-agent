import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { createServer, type Http2Server, type IncomingHttpHeaders } from "node:http2";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { ApnsClient, JWT_REFRESH_MS, ProviderToken, apnsJwt, jwtSigningInput, readP8, type ApnsCredentials } from "./apns.js";

/** RFC 7515, Appendix A.3: an ES256 public key, a signing input and its signature, as JOSE encodes them. */
const RFC = {
  jwk: { kty: "EC", crv: "P-256", x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU", y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0" },
  input: "eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ",
  signature: "DtEhU3ljbEg8L38VWAfUAqOyKAM6-Xx-F4GawxaepmXFCgfTjDxw5djxLa8ISlSApmWQxfKTUJqPP3-Kg6NU1Q",
};

const RFC_PUBLIC = createPublicKey({ key: RFC.jwk, format: "jwk" });

/** A key as Apple hands out a .p8: P-256, PKCS#8 PEM. */
const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const P8 = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const PUBLIC = pair.publicKey;
const TOKEN = "a".repeat(64);

const credentials = (over: Partial<ApnsCredentials> = {}): ApnsCredentials => ({ key: readP8(P8), keyId: "ABC123DEFG", teamId: "DEF123GHIJ", topic: "com.owner.kos-phone", ...over });

const verifies = (jwt: string): boolean => {
  const [header, claims, signature] = jwt.split(".");
  return verify("sha256", Buffer.from(`${header}.${claims}`), { key: PUBLIC, dsaEncoding: "ieee-p1363" }, Buffer.from(signature!, "base64url"));
};

describe("an APNs key", () => {
  it("reads as Apple's .p8, with or without its line breaks, or as its base64 alone", () => {
    const body = P8.replace(/-----(BEGIN|END) PRIVATE KEY-----|\s+/g, "");
    for (const text of [P8, P8.replace(/\n/g, " "), body]) expect(readP8(text).asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
  });

  it("is refused when it is not an EC P-256 key", () => {
    const ed = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const p384 = generateKeyPairSync("ec", { namedCurve: "secp384r1" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    expect(() => readP8(ed)).toThrow(/EC P-256/);
    expect(() => readP8(p384)).toThrow(/EC P-256/);
    expect(() => readP8("not a key at all")).toThrow(/not a .p8 key/);
    expect(() => readP8("")).toThrow(/not a .p8 key/);
  });
});

describe("the provider token", () => {
  it("is Apple's header and claims, base64url, exactly", () => {
    expect(jwtSigningInput("ABC123DEFG", "DEF123GHIJ", 1437179036)).toBe("eyJhbGciOiJFUzI1NiIsImtpZCI6IkFCQzEyM0RFRkcifQ.eyJpc3MiOiJERUYxMjNHSElKIiwiaWF0IjoxNDM3MTc5MDM2fQ");
  });

  it("is signed ES256 as JOSE encodes it: r and s, 64 bytes, as RFC 7515's own vector verifies", () => {
    // The verifier the token is checked with accepts the RFC's signature, so the encoding is JOSE's and not DER.
    expect(verify("sha256", Buffer.from(RFC.input), { key: RFC_PUBLIC, dsaEncoding: "ieee-p1363" }, Buffer.from(RFC.signature, "base64url"))).toBe(true);
    const jwt = apnsJwt(credentials(), 1437179036);
    expect(jwt.startsWith(`${jwtSigningInput("ABC123DEFG", "DEF123GHIJ", 1437179036)}.`)).toBe(true);
    expect(Buffer.from(jwt.split(".")[2]!, "base64url")).toHaveLength(64);
    expect(verifies(jwt)).toBe(true);
  });

  it("is kept under the hour, and signed again when it nears it, when the key changes, or once APNs refused it", () => {
    let now = 1_700_000_000_000;
    const tokens = new ProviderToken(() => now);
    const first = tokens.get(credentials());
    now += JWT_REFRESH_MS - 1;
    expect(tokens.get(credentials())).toBe(first);
    now += 1;
    const second = tokens.get(credentials());
    expect(second).not.toBe(first);
    expect(JSON.parse(Buffer.from(second.split(".")[1]!, "base64url").toString())).toEqual({ iss: "DEF123GHIJ", iat: Math.floor(now / 1000) });
    expect(tokens.get(credentials({ keyId: "ZZZ123DEFG" }))).not.toBe(second);
    const third = tokens.get(credentials());
    tokens.drop();
    expect(tokens.get(credentials())).not.toBe(third);
  });
});

/** APNs, played over cleartext HTTP/2 on loopback: what each request carried, and the answer the test gives. */
async function fakeApns(answer: (req: { headers: IncomingHttpHeaders; body: string }) => { status: number; reason?: string } = () => ({ status: 200 })) {
  const seen: { headers: IncomingHttpHeaders; body: string }[] = [];
  const server: Http2Server = createServer();
  server.on("stream", (stream, headers) => {
    let body = "";
    stream.setEncoding("utf8");
    stream.on("data", (c: string) => (body += c));
    stream.on("end", () => {
      const req = { headers, body };
      seen.push(req);
      const a = answer(req);
      stream.respond({ ":status": a.status, "apns-id": "11111111-2222-3333-4444-555555555555" });
      stream.end(a.reason ? JSON.stringify({ reason: a.reason }) : "");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  servers.push(server);
  return { seen, origin };
}

const servers: Http2Server[] = [];
const clients: ApnsClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

describe("a push to APNs", () => {
  const alert = { headers: { "apns-push-type": "alert", "apns-priority": "10", "apns-collapse-id": "kos.ask.41", "apns-expiration": "1761800000" }, payload: { aps: { alert: { title: "Garden asks", body: "Write notes/list.md" } }, kos: { ask: "41" } } };

  it("is a POST to the token's path, with the bearer token, the topic and the push's own headers, and its JSON", async () => {
    const apns = await fakeApns();
    const client = new ApnsClient({ origins: { sandbox: apns.origin } });
    clients.push(client);
    expect(await client.send(credentials(), { ...alert, token: TOKEN, env: "sandbox" })).toEqual({ status: 200 });
    const [req] = apns.seen;
    expect(req!.headers).toMatchObject({
      ":method": "POST",
      ":path": `/3/device/${TOKEN}`,
      "apns-topic": "com.owner.kos-phone",
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-collapse-id": "kos.ask.41",
      "apns-expiration": "1761800000",
      "content-type": "application/json",
    });
    const auth = String(req!.headers.authorization);
    expect(auth).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(verifies(auth.slice("bearer ".length))).toBe(true);
    expect(JSON.parse(req!.body)).toEqual(alert.payload);
  });

  it("goes to the gateway the token is good on, over one session for each", async () => {
    const sandbox = await fakeApns();
    const production = await fakeApns();
    const client = new ApnsClient({ origins: { sandbox: sandbox.origin, production: production.origin } });
    clients.push(client);
    await client.send(credentials(), { ...alert, token: TOKEN, env: "production" });
    await client.send(credentials(), { ...alert, token: TOKEN, env: "production" });
    await client.send(credentials(), { ...alert, token: TOKEN, env: "sandbox" });
    expect([production.seen.length, sandbox.seen.length]).toEqual([2, 1]);
  });

  it("says APNs' reason for a refusal, and signs a new token after one it called expired", async () => {
    let n = 0;
    const apns = await fakeApns(() => (n++ === 0 ? { status: 403, reason: "ExpiredProviderToken" } : n === 2 ? { status: 410, reason: "Unregistered" } : { status: 200 }));
    const client = new ApnsClient({ origins: { sandbox: apns.origin } });
    clients.push(client);
    expect(await client.send(credentials(), { ...alert, token: TOKEN, env: "sandbox" })).toEqual({ status: 403, reason: "ExpiredProviderToken" });
    expect(await client.send(credentials(), { ...alert, token: TOKEN, env: "sandbox" })).toEqual({ status: 410, reason: "Unregistered" });
    await client.send(credentials(), { ...alert, token: TOKEN, env: "sandbox" });
    const auths = apns.seen.map((r) => r.headers.authorization);
    expect(auths[1]).not.toBe(auths[0]);
    expect(auths[2]).toBe(auths[1]);
  });

  it("sends nothing for a token that is not one, and says when APNs cannot be reached", async () => {
    const apns = await fakeApns();
    const client = new ApnsClient({ origins: { sandbox: apns.origin, production: "http://127.0.0.1:1" }, timeoutMs: 2000 });
    clients.push(client);
    expect(await client.send(credentials(), { ...alert, token: "../../evil", env: "sandbox" })).toEqual({ status: 400, reason: "BadDeviceToken" });
    expect(apns.seen).toEqual([]);
    expect((await client.send(credentials(), { ...alert, token: TOKEN, env: "production" })).status).toBe(0);
  });
});
