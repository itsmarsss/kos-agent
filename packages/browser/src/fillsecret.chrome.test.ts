import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ChromeHost, findChrome } from "./chrome.js";
import { act, evaluate, fieldSpots, fillSecrets, look, stepsOf, visit, type Tab } from "./hands.js";
import { BrowserLive, DEFAULT_CONFIG } from "./live.js";
import { SecretRefused, type FillExpect, type Session } from "./page.js";
import type { SecretSlot } from "./taint.js";

/**
 * A secret filled into KOS's own Chrome (Page.fillSecret): only on the
 * origin and in the frame approved, only into a field of the right kind
 * that is drawn, in view and writable; checked without being read back;
 * and from then on said as hidden, kept from scripts and copies, and
 * painted out of every picture. Skipped where no Chrome is installed.
 */

const PASSWORD = "pw-Canary-7f3k9q2x";
const CARD = "4242424242424242";
const MAGENTA = "#ff00ff";

const page = (title: string, body: string): string =>
  `<!doctype html><meta charset=utf-8><title>${title}</title><style>input{color:${MAGENTA};font-size:28px;width:360px;height:44px;display:block;margin:6px}</style>${body}`;

describe.skipIf(!findChrome(undefined))("filling a secret in KOS's own Chrome", { timeout: 30_000 }, () => {
  let site: Server;
  let pay: Server;
  let base = "";
  let payBase = "";
  let scratch = "";
  let profile = "";
  let live: BrowserLive;
  let host: ChromeHost;
  let tab: Tab;

  const login = (): string =>
    page(
      "Sign in",
      `<label>Username <input id=user autocomplete=username></label>
<label>Password <input id=pw type=password autocomplete=current-password></label>
<label>Search <input id=q type=search></label>
<label>Locked <input id=ro type=password readonly></label>
<label>Tiny <input id=tiny type=password style="width:2px;height:2px;padding:0;border:0"></label>
<label>Ghost <input id=ghost type=password style="opacity:0"></label>
<div style="font-size:40px">You typed <span id=echo style="color:${MAGENTA}"></span></div>
<iframe id=payframe src="${payBase}/card" style="width:420px;height:160px;border:0"></iframe>
<script>document.getElementById('pw').addEventListener('input', (e) => { document.getElementById('echo').textContent = e.target.value; document.title = 'typed ' + e.target.value; });</script>`,
    );

  const answer = (req: IncomingMessage, res: ServerResponse): void => {
    const html = (body: string): void => void res.writeHead(200, { "content-type": "text/html" }).end(body);
    if (req.url === "/card") return html(page("Card", `<label>Card number <input id=num autocomplete=cc-number></label><label>Note <input id=note></label>`));
    if (req.url === "/magenta") return html(page("Magenta", `<div style="background:${MAGENTA};width:300px;height:200px"></div>`));
    if (req.url === "/next") return html(page("Next", `<p>Signed in.</p>`));
    html(login());
  };

  /** The tab's session, for what the test checks behind KOS's back: the page itself, never seen by the model. */
  const sessionOf = (t: Tab): Session => (t.page as unknown as { session: Session }).session;
  const peek = async (expression: string): Promise<unknown> => ((await sessionOf(tab).send("Runtime.evaluate", { expression, returnByValue: true }))["result"] as { value?: unknown }).value;
  /** A field's value wherever it is, its frame's too, found by id in the browser's tree of the page. */
  const peekField = async (id: string): Promise<unknown> => {
    type DomNode = { backendNodeId: number; attributes?: string[]; children?: DomNode[]; contentDocument?: DomNode };
    const find = (n: DomNode | undefined): number | undefined => {
      if (!n) return undefined;
      const attrs = n.attributes ?? [];
      if (attrs.some((a, i) => i % 2 === 0 && a === "id" && attrs[i + 1] === id)) return n.backendNodeId;
      for (const c of [...(n.children ?? []), ...(n.contentDocument ? [n.contentDocument] : [])]) {
        const got = find(c);
        if (got !== undefined) return got;
      }
      return undefined;
    };
    const session = sessionOf(tab);
    const node = find((await session.send("DOM.getDocument", { depth: -1, pierce: true }))["root"] as DomNode);
    const { object } = (await session.send("DOM.resolveNode", { backendNodeId: node })) as { object: { objectId: string } };
    return ((await session.send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: "function () { return this.value; }", returnByValue: true }))["result"] as { value?: unknown }).value;
  };
  /** How many pixels of a JPEG are near magenta, counted in a canvas on a page that holds no secret. */
  const magentaIn = async (jpeg: string): Promise<number> => {
    const counted = await tab.page.evaluate(`await (async () => {
      const img = new Image(); img.src = "data:image/jpeg;base64,${jpeg}"; await img.decode();
      const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
      const g = c.getContext("2d"); g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 190 && d[i + 1] < 90 && d[i + 2] > 190) n++;
      return n;
    })()`);
    return Number(counted);
  };
  /** The ref the last look gave a labelled control. */
  const refOf = (seen: string, label: string): string => {
    const m = new RegExp(`"${label}"[^\\n]*@(e\\d+)`).exec(seen);
    if (!m) throw new Error(`no ref for ${label} in:\n${seen}`);
    return `@${m[1]}`;
  };
  const expectFor = async (ref: string, slot: SecretSlot): Promise<FillExpect> => ({ ...(await fieldSpots(tab, [ref]))[0]!, slot });

  beforeAll(async () => {
    site = createServer(answer);
    pay = createServer(answer);
    for (const s of [site, pay]) await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const portOf = (s: Server): number => {
      const a = s.address();
      return typeof a === "object" && a ? a.port : 0;
    };
    base = `http://127.0.0.1:${portOf(site)}`;
    payBase = `http://127.0.0.1:${portOf(pay)}`;
    scratch = mkdtempSync(join(tmpdir(), "kos-fill-"));
    profile = join(scratch, "profile");
    // A mock keychain: under a test's HOME, Chrome would ask the owner's Mac for one.
    const binary = join(scratch, "chrome.sh");
    writeFileSync(binary, `#!/bin/sh\nexec ${JSON.stringify(findChrome(undefined))} --use-mock-keychain "$@"\n`);
    chmodSync(binary, 0o755);
    host = new ChromeHost({ port: 10_000 + Math.floor(Math.random() * 200), profileDir: profile, launch: () => ({ binary, windowSize: { width: 1100, height: 900 } }) });
    live = new BrowserLive({ config: () => DEFAULT_CONFIG, chrome: host });
    const id = await live.tabFor("fill");
    tab = { page: await live.page(id), capture: (w) => live.capture(id, w) };
    // A fresh Chrome's first page can take many seconds: paid here, not by the first test.
    await visit(tab, [`${base}/next`], { then: "none" });
  }, 60_000);

  afterAll(async () => {
    await live?.shutdown();
    await host?.waitGone();
    host?.stop();
    for (const s of [site, pay]) {
      s?.closeAllConnections();
      s?.close();
    }
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const open = async (): Promise<string> => (await visit(tab, [`${base}/`], { then: "look", until: "load" })).text;

  it("says where a field is by the browser's own frames: the page's origin and the frame's", async () => {
    const seen = await open();
    const [top, framed] = await fieldSpots(tab, [refOf(seen, "Password"), refOf(seen, "Card number")]);
    expect(top).toMatchObject({ origin: base, frameOrigin: base });
    expect(framed).toMatchObject({ origin: base, frameOrigin: payBase });
    expect(framed!.doc).toBe(top!.doc);
    await expect(fieldSpots(tab, ["@e999"])).rejects.toMatchObject({ code: "ref" });
  });

  it("fills a login on its origin and a card in the frame allowed, checked without reading it back", async () => {
    const seen = await open();
    const fills = [
      { ref: refOf(seen, "Username"), value: "owner", expect: await expectFor(refOf(seen, "Username"), "username") },
      { ref: refOf(seen, "Password"), value: PASSWORD, expect: await expectFor(refOf(seen, "Password"), "password") },
      { ref: refOf(seen, "Card number"), value: CARD, expect: await expectFor(refOf(seen, "Card number"), "card-number") },
    ];
    const after = await fillSecrets(tab, fills, "look");
    expect(await peek("document.getElementById('pw').value")).toBe(PASSWORD);
    expect(await peek("document.getElementById('user').value")).toBe("owner");
    expect(await peekField("num")).toBe(CARD);
    // What KOS hands back says the secrets are there, never what they are, though the page echoes one into its text and title.
    expect(after.text).toContain('textbox "Password" = "(hidden)"');
    expect(after.text).toMatch(/textbox "Card number"( \[focused\])? = "\(hidden\)"/);
    expect(after.text).toContain('textbox "Username" = "owner"');
    for (const said of [after.text, (await look(tab, "snapshot")).text, (await look(tab, "read")).text]) {
      expect(said).not.toContain(PASSWORD);
      expect(said).not.toContain(CARD);
    }
    expect(after.text).toContain("Title: typed (hidden)");
  });

  it("keeps scripts, copies and typing off a page holding a secret until it changes", async () => {
    const seen = await open();
    const pw = refOf(seen, "Password");
    await fillSecrets(tab, [{ ref: pw, value: PASSWORD, expect: await expectFor(pw, "password") }], "none");
    await expect(evaluate(tab, "document.getElementById('pw').value")).rejects.toThrow(/browser\.eval is refused: a secret was filled/);
    await expect(act(tab, stepsOf([{ click: pw }, { press: "Meta+c" }]), "none")).rejects.toThrow(/Meta\+c is refused/);
    await expect(act(tab, stepsOf([{ type: { target: pw, text: "x" } }]), "none")).rejects.toThrow(/typing into .* is refused/);
    await expect(act(tab, stepsOf([{ fill: { target: pw, text: "x" } }]), "none")).rejects.toThrow(/filling .* is refused/);
    // A copy key on a field that holds no secret goes through.
    await act(tab, stepsOf([{ click: refOf(seen, "Username") }, { press: "Meta+a" }]), "none");
    expect(await peek("document.getElementById('pw').value")).toBe(PASSWORD);
    await visit(tab, [`${base}/next`], { then: "none" });
    expect(await evaluate(tab, "document.title")).toContain("Next");
  });

  it("refuses a page or a frame other than the one approved, and a page changed since", async () => {
    const seen = await open();
    const pw = refOf(seen, "Password");
    const card = refOf(seen, "Card number");
    const right = await expectFor(pw, "password");
    const refused = async (ref: string, expect: FillExpect): Promise<SecretRefused> =>
      fillSecrets(tab, [{ ref, value: PASSWORD, expect }], "none").then(
        () => {
          throw new Error("filled");
        },
        (err: unknown) => err as SecretRefused,
      );
    expect((await refused(pw, { ...right, origin: "https://example.com" })).code).toBe("origin");
    // The card's frame is another origin than the page: a card allowed on the page alone is refused there.
    expect((await refused(card, { ...(await expectFor(card, "card-number")), frameOrigin: base })).code).toBe("origin");
    expect((await refused(pw, { ...right, doc: "another document" })).code).toBe("changed");
    expect(await peek("document.getElementById('pw').value")).toBe("");
    for (const message of [(await refused(pw, { ...right, origin: "https://example.com" })).message]) expect(message).not.toContain(PASSWORD);
  });

  it("refuses a field of the wrong kind, a hidden one and one that cannot be written", async () => {
    const seen = await open();
    const cases: [label: string, slot: SecretSlot, why: RegExp][] = [
      ["Search", "password", /a search field does not take a password/],
      ["Username", "password", /a text field does not take a password/],
      ["Locked", "password", /read-only/],
      ["Tiny", "password", /hidden \(too small/],
      ["Ghost", "password", /hidden/],
      ["Note", "card-number", /does not take a card number/],
    ];
    for (const [label, slot, why] of cases) {
      const ref = refOf(seen, label);
      const err = await fillSecrets(tab, [{ ref, value: PASSWORD, expect: await expectFor(ref, slot) }], "none").catch((e: unknown) => e as SecretRefused);
      expect(err).toBeInstanceOf(SecretRefused);
      expect({ label, code: (err as SecretRefused).code }).toEqual({ label, code: "field" });
      expect((err as SecretRefused).message).toMatch(why);
      expect((err as SecretRefused).message).not.toContain(PASSWORD);
    }
    expect(await peek("[...document.querySelectorAll('input')].map((i) => i.value).join('')")).toBe("");
  });

  it("paints every secret out of a picture of the page, and puts the page back after", async () => {
    await visit(tab, [`${base}/magenta`], { then: "none" });
    const baseline = await tab.capture(1000);
    const seen = await open();
    const pw = refOf(seen, "Password");
    const card = refOf(seen, "Card number");
    await fillSecrets(tab, [
      { ref: pw, value: PASSWORD, expect: await expectFor(pw, "password") },
      { ref: card, value: CARD, expect: await expectFor(card, "card-number") },
    ], "none");
    // Unmasked, the field's dots and the page's echo of the password are magenta.
    const raw = (await sessionOf(tab).send("Page.captureScreenshot", { format: "jpeg", quality: 60 }))["data"] as string;
    const masked = await tab.capture(1000);
    expect(masked).toBeDefined();
    // Put back as it was: the page shows its own colours again.
    expect(await peek("getComputedStyle(document.getElementById('pw')).color")).toBe("rgb(255, 0, 255)");
    expect(await peek("document.getElementById('pw').getAttribute('style')")).toBeNull();
    expect(await peek("CSS.highlights.has('kos-secret')")).toBe(false);
    // Counted on a page with no secret, where a script may run.
    await visit(tab, [`${base}/next`], { then: "none" });
    expect(await magentaIn(baseline!)).toBeGreaterThan(1000);
    expect(await magentaIn(raw)).toBeGreaterThan(200);
    expect(await magentaIn(masked!)).toBeLessThan(20);
  });
});
