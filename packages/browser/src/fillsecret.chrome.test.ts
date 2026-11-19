import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ChromeHost, findChrome } from "./chrome.js";
import { act, evaluate, fieldSpots, fillSecrets, look, stepsOf, visit, type Tab } from "./hands.js";
import type { CdpClient } from "./cdp.js";
import { BrowserLive, DEFAULT_CONFIG } from "./live.js";
import { SecretRefused, type FillExpect, type SecretPut, type Session } from "./page.js";
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
const TOKEN = "tok-Canary-55h2m";
/** A password a page's address would carry only encoded. */
const SYMBOLS = `Sym &=+%/?#"<>' x!`;

/**
 * A page's own watch for a picture's masking, started by watch(): every
 * mutation of its tree, in its shadow roots too, and every change, polled,
 * to its highlights, its style sheets, its elements' style attributes and
 * the computed styles of its field and its echo. Each is kept in seen.
 */
const ORACLE = `window.seen = [];
const echo = document.getElementById('echo');
const pw = document.getElementById('pw');
pw.addEventListener('input', (e) => { echo.textContent = e.target.value; });
window.watch = () => {
  const note = (what) => window.seen.push(what);
  new MutationObserver((ms) => ms.forEach((m) => note(m.type + ':' + (m.attributeName || '')))).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  const look = () => JSON.stringify([CSS.highlights.size, document.styleSheets.length, [...document.querySelectorAll('*')].map((el) => el.getAttribute('style')).join('|'), ...[pw, echo].flatMap((el) => { const c = getComputedStyle(el); return [c.color, c.webkitTextSecurity, c.textShadow]; })]);
  let last = look();
  setInterval(() => { const now = look(); if (now !== last) { note('style:' + now); last = now; } }, 1);
};`;

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
<label>Nickname <input id=nick></label>
<div style="font-size:40px">You typed <span id=echo style="color:${MAGENTA}"></span></div>
<iframe id=payframe src="${payBase}/card" style="width:420px;height:160px;border:0"></iframe>
<script>document.getElementById('pw').addEventListener('input', (e) => { document.getElementById('echo').textContent = e.target.value; document.title = 'typed ' + e.target.value; });</script>`,
    );

  const answer = (req: IncomingMessage, res: ServerResponse): void => {
    const html = (body: string): void => void res.writeHead(200, { "content-type": "text/html" }).end(body);
    if (req.url === "/card") return html(page("Card", `<label>Card number <input id=num autocomplete=cc-number></label><label>Note <input id=note></label>`));
    if (req.url === "/magenta") return html(page("Magenta", `<div style="background:${MAGENTA};width:300px;height:200px"></div>`));
    if (req.url === "/next") return html(page("Next", `<p>Signed in.</p>`));
    // A page that copies the password into another box, a textarea and a box in a shadow root, and can show it as text.
    if (req.url === "/mirror")
      return html(
        page(
          "Mirror",
          `<label>Password <input id=pw type=password></label><button id=show onclick="const p = document.getElementById('pw'); p.type = p.type === 'password' ? 'text' : 'password'">Show password</button>
<label>Mirror <input id=mirror></label><textarea id=area style="color:${MAGENTA};font-size:28px"></textarea><div id=host></div>
<script>const inner = document.getElementById('host').attachShadow({ mode: 'open' }); inner.innerHTML = '<input id=deep style="color:${MAGENTA};font-size:28px">';
document.getElementById('pw').addEventListener('input', (e) => { const v = e.target.value; document.getElementById('mirror').value = v; document.getElementById('area').value = v; inner.getElementById('deep').value = v; });</script>`,
        ),
      );
    // A page that takes the keyboard off the password field the moment it gets it; with ?keys, one that also throws away a value no key typed.
    if (req.url?.startsWith("/decoy"))
      return html(
        page(
          "Decoy",
          `<label>Password <input id=pw type=password></label><label>Comment <input id=decoy></label>
<script>const pw = document.getElementById('pw'); pw.addEventListener('focus', () => document.getElementById('decoy').focus());
${req.url.includes("keys") ? "pw.addEventListener('input', (e) => { if (!e.isTrusted) pw.value = ''; });" : ""}</script>`,
        ),
      );
    // Keys only, and nothing in the way: typed for real.
    if (req.url === "/keys") return html(page("Keys", `<label>Password <input id=pw type=password></label><script>const pw = document.getElementById('pw'); pw.addEventListener('input', (e) => { if (!e.isTrusted) pw.value = ''; });</script>`));
    // A sign-in page that opens a window of its own, which can reach back to it.
    if (req.url === "/opener") return html(page("Opener", `<label>Password <input id=pw type=password></label><button id=pop onclick="window.open('/next', 'kid')">Open</button>`));
    if (req.url === "/getform") return html(page("Get", `<form method=get action="/echo"><label>Password <input id=pw type=password name=pw></label></form>`));
    // Forms the browser sends by GET though they do not say so: no method, one it does not know, a submit button's formmethod.
    if (req.url === "/nomethod") return html(page("Get", `<form action="/echo"><label>Password <input id=pw type=password name=pw></label></form>`));
    if (req.url === "/badmethod") return html(page("Get", `<form method=bogus action="/echo"><label>Password <input id=pw type=password name=pw></label></form>`));
    if (req.url === "/submitget")
      return html(page("Get", `<form method=post action="/echo"><label>Password <input id=pw type=password name=pw></label><button formmethod=get>Go</button></form>`));
    // A page that sends the password in the address by script, encoded every way a page may.
    if (req.url === "/jsget")
      return html(
        page(
          "Script get",
          `<label>Password <input id=pw type=password></label><button id=go onclick="const v = document.getElementById('pw').value; location.href = '/sent?a=' + encodeURIComponent(v) + '&' + new URLSearchParams({ b: v }) + '&c=' + encodeURIComponent(v).replace(/%[0-9A-F]{2}/g, (h) => h.toLowerCase())">Go</button>`,
        ),
      );
    if (req.url?.startsWith("/sent")) return html(page("Sent", `<p>Raw ${req.url}</p>`));
    // A token in a plain box, which the browser puts back when history comes back to the page.
    if (req.url === "/token") return html(page("Token", `<label>API token <input id=tok></label>`));
    // A page that echoes the password where only KOS's own tree of the page reaches (a closed shadow root), and as a placeholder, a select, SVG text and a ::before.
    if (req.url === "/hidden-echoes")
      return html(
        page(
          "Echoes",
          `<style>::placeholder{color:${MAGENTA}} #before::before{content:attr(data-v);color:${MAGENTA};font-size:40px}</style>
<label>Password <input id=pw type=password></label><input id=ph style="color:#000" placeholder="magenta words here">
<div id=host></div><select id=sel style="font-size:28px;color:${MAGENTA}"><option id=opt></option></select>
<svg width=600 height=60><text id=svgtext x=0 y=45 font-size=40 fill="${MAGENTA}"></text></svg><div id=before></div>
<script>const inner = document.getElementById('host').attachShadow({ mode: 'closed' }); inner.innerHTML = '<input id=deep style="color:${MAGENTA};font-size:28px"><span id=said style="color:${MAGENTA};font-size:40px"></span>';
document.getElementById('pw').addEventListener('input', (e) => { const v = e.target.value; inner.getElementById('deep').value = v; inner.getElementById('said').textContent = v; document.getElementById('opt').textContent = v; document.getElementById('svgtext').textContent = v; document.getElementById('before').dataset.v = v; });</script>`,
        ),
      );
    // A page that watches itself for any sign of a picture's masking: a change to its tree, its attributes, its styles or its highlights.
    if (req.url === "/oracle") return html(page("Oracle", `<label>Password <input id=pw type=password></label><div style="font-size:40px">guess-one <span id=echo style="color:${MAGENTA}"></span></div><script>${ORACLE}</script>`));
    // A tall page whose password field sits a screen and more down, beside a blue block a picture of the right part shows.
    if (req.url?.startsWith("/tall"))
      return html(
        page("Tall", `<div style="height:${Number(req.url.split("?")[1] ?? 0) + 300}px"></div><label>Password <input id=pw type=password></label><div style="background:#0000ff;width:400px;height:200px"></div><div style="height:2000px"></div>`),
      );
    // A page with something moving on it.
    if (req.url === "/moving")
      return html(
        page("Moving", `<style>@keyframes turn{to{transform:rotate(360deg)}}</style><div id=spin style="width:40px;height:40px;background:#888;animation:turn 2s steps(4) infinite"></div><div id=form style="animation:turn 2s steps(4) infinite;margin:40px"><label>Password <input id=pw type=password></label></div>`),
      );
    // A frame drawn upside down, its magenta box in a corner that turning moves to the opposite one.
    if (req.url === "/turned")
      return html(page("Turned", `<label>Password <input id=pw type=password></label><iframe src="${payBase}/corner" style="width:500px;height:300px;border:0;transform:rotate(180deg)"></iframe>`));
    if (req.url === "/corner") return html(page("Corner", `<input id=box value="magenta words" style="width:200px;margin:0">`));
    if (req.url?.startsWith("/echo")) return html(page("Echo", `<p>You sent ${decodeURIComponent(req.url.split("=")[1] ?? "")}</p>`));
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
  /** How many pixels of a JPEG are near pure blue, counted as magentaIn counts. */
  const blueIn = async (jpeg: string): Promise<number> =>
    Number(
      await tab.page.evaluate(`await (async () => {
      const img = new Image(); img.src = "data:image/jpeg;base64,${jpeg}"; await img.decode();
      const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
      const g = c.getContext("2d"); g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 70 && d[i + 1] < 70 && d[i + 2] > 190) n++;
      return n;
    })()`),
    );
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
    host = new ChromeHost({ port: 10_000 + Math.floor(Math.random() * 200), profileDir: profile, launch: () => ({ windowSize: { width: 1100, height: 900 } }) });
    live = new BrowserLive({ config: () => DEFAULT_CONFIG, chrome: host });
    const id = await live.tabFor("fill");
    tab = { page: await live.page(id), capture: (w) => live.capture(id, w) };
    // A fresh Chrome's first page can take many seconds: paid here, not by the first test.
    await visit(tab, [`${base}/next`], { then: "none" });
  }, 60_000);

  afterAll(async () => {
    await live?.shutdown();
    await host?.waitGone();
    await host?.stop();
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
    expect(top).toMatchObject({ origin: base, frameOrigin: base, field: { label: "Password", type: "password" } });
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
    // Every other way a field's text is copied, cut or pasted, and any editing command on it.
    for (const key of ["Control+Insert", "Shift+Insert", "Shift+Delete", "Meta+v", "Meta+z"]) {
      await expect(act(tab, stepsOf([{ click: pw }, { press: key }]), "none")).rejects.toThrow(/is refused/);
    }
    // A key that types into the field or deletes from it edits the secret in place, where an echo of it would no longer be found.
    for (const key of ["x", "Space", "Backspace", "Delete"]) {
      await expect(act(tab, stepsOf([{ click: pw }, { press: key }]), "none")).rejects.toThrow(/is refused/);
    }
    await act(tab, stepsOf([{ click: pw }, { press: "Enter" }]), "none");
    await expect(act(tab, stepsOf([{ type: { target: pw, text: "x" } }]), "none")).rejects.toThrow(/typing into .* is refused/);
    await expect(act(tab, stepsOf([{ fill: { target: pw, text: "x" } }]), "none")).rejects.toThrow(/filling .* is refused/);
    await expect(act(tab, stepsOf([{ drag: { from: pw, to: refOf(seen, "Username") } }]), "none")).rejects.toThrow(/dragging is refused/);
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

  it("hands the value to a browser that puts it in itself, after its own checks, and holds the page as its own fill does", async () => {
    const seen = await open();
    const pw = refOf(seen, "Password");
    const right = await expectFor(pw, "password");
    // As KOS for Chrome's page is made (OwnerChrome): the value goes to the extension, which puts it in.
    const puts: (Omit<SecretPut, "value"> & { given: boolean })[] = [];
    const own = tab.page as unknown as { putSecret?: (put: SecretPut) => Promise<void> };
    own.putSecret = async ({ value, ...put }) => void puts.push({ ...put, given: value === PASSWORD });
    try {
      await expect(fillSecrets(tab, [{ ref: pw, value: PASSWORD, expect: { ...right, origin: "https://example.com" } }], "none")).rejects.toMatchObject({ code: "origin" });
      expect(puts).toEqual([]);
      await fillSecrets(tab, [{ ref: pw, value: PASSWORD, expect: right }], "none");
      expect(puts).toEqual([{ node: expect.any(Number), frame: expect.any(String), doc: right.doc, origin: base, frameOrigin: base, slot: "password", given: true }]);
      // Nothing of the Page's own put it in, and the page is held to the secret all the same.
      expect(await peek("document.getElementById('pw').value")).toBe("");
      await expect(evaluate(tab, "1")).rejects.toThrow(/browser\.eval is refused: a secret was filled/);
    } finally {
      delete own.putSecret;
      await visit(tab, [`${base}/next`], { then: "none" });
    }
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
      ["Nickname", "token", /does not take a token/],
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

  const fillPassword = async (path: string, value = PASSWORD): Promise<string> => {
    const seen = (await visit(tab, [`${base}${path}`], { then: "look", until: "load" })).text;
    const pw = refOf(seen, "Password");
    await fillSecrets(tab, [{ ref: pw, value, expect: await expectFor(pw, "password") }], "none");
    return seen;
  };

  it("masks a secret a page copies into another box, a textarea, a shadow root, or shows as text", async () => {
    const seen = await fillPassword("/mirror");
    expect(await peek("document.getElementById('area').value")).toBe(PASSWORD);
    await act(tab, stepsOf([{ click: refOf(seen, "Show password") }]), "none");
    expect(await peek("document.getElementById('pw').type")).toBe("text");
    const masked = await tab.capture(1000);
    const said = (await look(tab, "look")).text + (await look(tab, "snapshot")).text;
    expect(said).not.toContain(PASSWORD);
    await visit(tab, [`${base}/next`], { then: "none" });
    expect(await magentaIn(masked!)).toBeLessThan(20);
  });

  it("puts the value on the field itself, wherever the page moves the keyboard", async () => {
    await fillPassword("/decoy");
    expect(await peek("document.getElementById('pw').value")).toBe(PASSWORD);
    expect(await peek("document.getElementById('decoy').value")).toBe("");
  });

  it("types for real only while the field has the keyboard, and refuses when the page takes it", async () => {
    await fillPassword("/keys");
    expect(await peek("document.getElementById('pw').value")).toBe(PASSWORD);
    const err = await fillPassword("/decoy?keys").catch((e: unknown) => e as SecretRefused);
    expect(err).toMatchObject({ code: "focus" });
    expect(await peek("document.getElementById('decoy').value")).toBe("");
  });

  it("refuses a form that sends in the address, and masks a value a later page echoes", async () => {
    for (const path of ["/getform", "/nomethod", "/badmethod", "/submitget"]) {
      await expect(fillPassword(path)).rejects.toMatchObject({ code: "field", message: expect.stringMatching(/in the address \(GET\)/) });
    }
    await fillPassword("/");
    const echoed = await visit(tab, [`${base}/echo?x=${PASSWORD}`], { then: "read" });
    expect(echoed.text).toContain("You sent (hidden)");
    expect(echoed.text).toContain("URL: " + `${base}/echo?x=(hidden)`);
    // The first line repeats the address the caller gave; everything read from the page is masked.
    expect(echoed.text.split("\n").slice(1).join("\n")).not.toContain(PASSWORD);
  });

  it("opens no javascript: address, and no data: one while a page holds a secret", async () => {
    await fillPassword("/");
    const steal = "javascript:document.title=document.getElementById('pw').value";
    await expect(act(tab, stepsOf([{ open: steal }]), "none")).rejects.toThrow(/javascript: addresses are not opened/);
    await expect(tab.page.goto(steal)).rejects.toThrow(/not opened/);
    await expect(tab.page.goto(" JavaScript:void 0")).rejects.toThrow(/not opened/);
    await expect(act(tab, stepsOf([{ open: "data:text/html,<p>x" }]), "none")).rejects.toThrow(/data: address is refused/);
    expect(await peek("document.title")).toBe(`typed ${PASSWORD}`);
    await visit(tab, [`${base}/next`], { then: "none" });
    await act(tab, stepsOf([{ open: "data:text/html,<title>plain</title>" }]), "none");
    expect(await peek("document.title")).toBe("plain");
  });

  it("masks a symbol-heavy password a script sends in the address, however it is encoded", async () => {
    const seen = await fillPassword("/jsget", SYMBOLS);
    const sent = await act(tab, stepsOf([{ click: refOf(seen, "Go") }]), "read");
    const said = [sent.text, (await look(tab, "read")).text, await evaluate(tab, "location.href"), await evaluate(tab, "({ href: location.href, search: decodeURIComponent(location.search) })")];
    expect(said[0]).toContain("Raw /sent?a=(hidden)&b=(hidden)&c=(hidden)");
    for (const text of said) {
      for (const form of [SYMBOLS, encodeURIComponent(SYMBOLS), new URLSearchParams({ b: SYMBOLS }).toString().slice(2), encodeURIComponent(SYMBOLS).replace(/%[0-9A-F]{2}/g, (h) => h.toLowerCase())]) expect(text).not.toContain(form);
    }
  });

  it("holds a page come back to by history as it held it: the browser may put the secret back", async () => {
    const seen = (await visit(tab, [`${base}/token`], { then: "look", until: "load" })).text;
    const tok = refOf(seen, "API token");
    await fillSecrets(tab, [{ ref: tok, value: TOKEN, expect: await expectFor(tok, "token") }], "none");
    await visit(tab, [`${base}/next`], { then: "none" });
    expect(await evaluate(tab, "document.title")).toContain("Next");
    const back = await act(tab, stepsOf([{ go: "back" }]), "look");
    expect(await peek("location.pathname")).toBe("/token");
    await expect(evaluate(tab, "document.getElementById('tok').value")).rejects.toThrow(/browser\.eval is refused/);
    await expect(look(tab, "read", "#tok")).rejects.toThrow(/refused/);
    for (const text of [back.text, (await look(tab, "snapshot")).text]) expect(text).not.toContain(TOKEN);
  });

  it("keeps every tab of the conversation from a secret: a popup reads nothing of its opener", async () => {
    // A conversation of its own: a script in the popup could reach its opener, which then takes no fill again.
    const id = await live.tabFor("popups");
    const opener: Tab = { page: await live.page(id), capture: (w) => live.capture(id, w) };
    const seen = (await visit(opener, [`${base}/opener`], { then: "look", until: "load" })).text;
    const before = live.tabsOf("popups").length;
    await act(opener, stepsOf([{ click: refOf(seen, "Open") }]), "none");
    await expect.poll(() => live.tabsOf("popups").length, { timeout: 5_000 }).toBeGreaterThan(before);
    const kid = live.tabsOf("popups").find((t) => t !== id)!;
    const popup: Tab = { page: await live.page(kid), capture: (w) => live.capture(kid, w) };
    try {
      const pw = refOf(seen, "Password");
      await fillSecrets(opener, [{ ref: pw, value: PASSWORD, expect: { ...(await fieldSpots(opener, [pw]))[0]!, slot: "password" } }], "none");
      await expect(evaluate(popup, "opener.document.getElementById('pw').value")).rejects.toThrow(/browser\.eval is refused/);
      await expect(act(popup, stepsOf([{ open: "data:text/html,<script>1</script>" }]), "none")).rejects.toThrow(/data: address is refused/);
      // The popup's own words are cleaned of what its opener holds.
      await sessionOf(popup).send("Runtime.evaluate", { expression: `document.body.textContent = ${JSON.stringify(`echo ${PASSWORD}`)}` });
      expect((await look(popup, "read")).text).toContain("echo (hidden)");
      // Once no tab holds it, scripts run again.
      await visit(opener, [`${base}/next`], { then: "none" });
      expect(await evaluate(popup, "document.title")).toContain("Next");
    } finally {
      await live.closeTab(kid);
    }
  });

  it("paints out of a picture what only KOS's tree reaches: a closed shadow root, a placeholder, a select, SVG text, a ::before", async () => {
    await fillPassword("/hidden-echoes");
    const raw = (await sessionOf(tab).send("Page.captureScreenshot", { format: "jpeg", quality: 60 }))["data"] as string;
    const masked = await tab.capture(1000);
    expect(await peek("CSS.highlights.has('kos-secret')")).toBe(false);
    expect(await peek("document.querySelectorAll('[data-kos-masked]').length")).toBe(0);
    await visit(tab, [`${base}/next`], { then: "none" });
    expect(await magentaIn(raw)).toBeGreaterThan(1000);
    expect(await magentaIn(masked!)).toBeLessThan(20);
  });

  it("masks a picture with nothing a page can see: no mutation, style or highlight while it is taken", async () => {
    await fillPassword("/oracle");
    await peek("window.watch()");
    await new Promise((r) => setTimeout(r, 50));
    const raw = (await sessionOf(tab).send("Page.captureScreenshot", { format: "jpeg", quality: 60 }))["data"] as string;
    const masked = await tab.capture(1000);
    await new Promise((r) => setTimeout(r, 50));
    expect(await peek("JSON.stringify(window.seen)")).toBe("[]");
    await visit(tab, [`${base}/next`], { then: "none" });
    expect(await magentaIn(raw)).toBeGreaterThan(200);
    expect(await magentaIn(masked!)).toBeLessThan(20);
  });

  it("masks a scrolled page where it is drawn, and pictures the part of it on screen", async () => {
    for (const scrolled of [200, 1500]) {
      await fillPassword(`/tall?${scrolled}`);
      await sessionOf(tab).send("Runtime.evaluate", { expression: `window.scrollTo(0, ${scrolled})` });
      expect(await peek("Math.round(window.scrollY)")).toBe(scrolled);
      const raw = (await sessionOf(tab).send("Page.captureScreenshot", { format: "jpeg", quality: 60 }))["data"] as string;
      const masked = await tab.capture(1000);
      await visit(tab, [`${base}/next`], { then: "none" });
      expect(await magentaIn(raw)).toBeGreaterThan(200);
      expect(await magentaIn(masked!)).toBeLessThan(20);
      // The part of the page on screen, not its top: the blue block beside the field is there.
      expect(await blueIn(masked!)).toBeGreaterThan(5_000);
    }
  });

  it("pictures no page that is moving, and paints a frame drawn turned over whole", async () => {
    await fillPassword("/moving");
    expect(await tab.capture(1000)).toBeUndefined();
    // Something else moving, the spinner, is no reason not to picture it.
    await sessionOf(tab).send("Runtime.evaluate", { expression: "document.getElementById('form').getAnimations().forEach((a) => a.cancel())" });
    expect(await tab.capture(1000)).toBeDefined();
    await fillPassword("/turned");
    const raw = (await sessionOf(tab).send("Page.captureScreenshot", { format: "jpeg", quality: 60 }))["data"] as string;
    const masked = await tab.capture(1000);
    await visit(tab, [`${base}/next`], { then: "none" });
    expect(await magentaIn(raw)).toBeGreaterThan(200);
    expect(await magentaIn(masked!)).toBeLessThan(20);
  });

  it("takes only refs while the page holds a secret: no selector, no scope, no wait for words", async () => {
    await fillPassword("/");
    await expect(act(tab, stepsOf([{ click: "#pw" }]), "none")).rejects.toThrow(/aiming at #pw is refused/);
    await expect(act(tab, stepsOf([{ wait: { text: "pw-" } }]), "none")).rejects.toThrow(/waiting for words is refused/);
    await expect(look(tab, "look", "#pw")).rejects.toThrow(/looking within #pw is refused/);
    await expect(look(tab, "read", "body")).rejects.toThrow(/refused/);
  });

  it("holds the page through hands made again after a detach, and gives the tab to no other conversation", async () => {
    const id = live.tabOf("fill")!;
    await fillPassword("/");
    const inner = live as unknown as { cdp: CdpClient; sessions: Map<string, string> };
    await inner.cdp.send("Target.detachFromTarget", { sessionId: inner.sessions.get(id) });
    await expect.poll(() => inner.sessions.has(id)).toBe(false);
    const before = tab.page;
    tab = { page: await live.page(id), capture: (w) => live.capture(id, w) };
    expect(tab.page).not.toBe(before);
    await expect(evaluate(tab, "document.getElementById('pw').value")).rejects.toThrow(/browser\.eval is refused: a secret was filled/);
    expect((await look(tab, "look")).text).toContain('textbox "Password" = "(hidden)"');
    // Its secrets are its conversation's: another taking the tab would hold none of them.
    expect(() => live.useTab("another", id)).toThrow(/a secret was filled in its tabs/);
    expect(live.tabOf("fill")).toBe(id);
    await visit(tab, [`${base}/next`], { then: "none" });
  });
});
