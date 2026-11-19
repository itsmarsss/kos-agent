import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findChrome } from "@kos/browser";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Inference } from "../agent/loop.js";
import { Kernel } from "../kernel/kernel.js";
import type { ProgressEvent } from "../kernel/progress.js";
import { handleApiRequest } from "../kernel/server.js";
import type { GenerateRequest, ModelMessage, ModelResponse } from "../models/types.js";
import { needlesOf } from "./scrub.js";
import { SecretsRegistry } from "./secrets.js";
import { Vault } from "./vault.js";

/**
 * A secret filled into KOS's own Chrome leaves no trace of its value
 * (design section 11): a scripted turn lists the secrets, fills a login on
 * the page and a card in a payment frame of another origin, fills a
 * one-time code the owner typed on its card, shows the
 * password with the page's own toggle, looks at the page as a picture, an
 * outline and its text, and tries a script and a javascript: address, both refused. The page
 * echoes whatever is typed into its text, its title and its console,
 * copies the password into another box and a textarea, and draws it in
 * magenta. Afterwards no canary is in any table, the transcript, a
 * progress event, a model request, a tool result, the conversation's
 * messages or what KOS printed, and no picture KOS kept or sent shows the
 * magenta. Skipped where no Chrome is installed.
 */

const rand = (n: number): string => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => (b % 36).toString(36)).join("");
function luhnCard(): string {
  const digits = [4, ...Array.from({ length: 14 }, () => Math.floor(Math.random() * 10))];
  const sum = digits
    .slice()
    .reverse()
    .reduce((acc, d, i) => acc + (i % 2 === 0 ? (d * 2 > 9 ? d * 2 - 9 : d * 2) : d), 0);
  return [...digits, (10 - (sum % 10)) % 10].join("");
}

const step = (content: ModelResponse["content"], stopReason: ModelResponse["stopReason"] = "tool_use"): ModelResponse => ({ content, stopReason, usage: { inputTokens: 0, outputTokens: 0 }, model: "stub" });

const MAGENTA = "#ff00ff";
const html = (title: string, body: string): string =>
  `<!doctype html><meta charset=utf-8><title>${title}</title><style>input{font-size:26px;width:380px;height:42px;display:block;margin:6px}#pw,#num{color:${MAGENTA}}</style>${body}`;
/** Whatever is typed into a field, echoed into the page, its title and its console. */
const ECHO = `<script>for (const el of document.querySelectorAll('input')) el.addEventListener('input', (e) => { document.getElementById('echo').textContent = e.target.value; document.title = 'typed ' + e.target.value; console.log('typed', e.target.value); });</script>`;

/** A free port on this machine, for a Chrome of the test's own: never the live host's. */
async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

describe.skipIf(!findChrome(undefined))("a secret filled into KOS's browser never leaks", { timeout: 120_000 }, () => {
  let root: string;
  let kernel: Kernel;
  let vault: Vault;
  let site: Server;
  let pay: Server;
  let base = "";
  let payBase = "";
  let password = "";
  let card = "";
  /** The one-time code the owner types on its card: never saved, used once. */
  let code = "";
  let canaries: string[] = [];
  const requests: GenerateRequest[] = [];
  const events: ProgressEvent[] = [];
  const printed: string[] = [];

  const answer = (req: IncomingMessage, res: ServerResponse): void => {
    const page = (body: string): void => void res.writeHead(200, { "content-type": "text/html" }).end(body);
    if (req.url === "/card") return page(html("Card", `<label>Card number <input id=num autocomplete=cc-number></label><div id=echo style="color:${MAGENTA};font-size:30px"></div>${ECHO}`));
    page(
      html(
        "Sign in",
        `<label>Username <input id=user autocomplete=username></label>
<label>Password <input id=pw type=password autocomplete=current-password></label>
<label>Confirm <input id=honey type=password style="position:absolute;left:-9999px"></label>
<button id=show onclick="const p = document.getElementById('pw'); p.type = p.type === 'password' ? 'text' : 'password'">Show password</button>
<label>Preview <input id=mirror style="color:${MAGENTA}"></label><textarea id=area style="color:${MAGENTA};font-size:26px"></textarea>
<label>One-time code <input id=otp autocomplete=one-time-code style="color:${MAGENTA}"></label>
<script>document.getElementById('pw').addEventListener('input', (e) => { document.getElementById('mirror').value = e.target.value; document.getElementById('area').value = e.target.value; });</script>
<div id=echo style="color:${MAGENTA};font-size:30px"></div>
<iframe src="${payBase}/card" style="width:440px;height:140px;border:0"></iframe>${ECHO}`,
      ),
    );
  };

  /** The refs the page's first look gave its fields, as the model read them. */
  const refs = new Map<string, string>();
  const readRefs = (messages: ModelMessage[]): void => {
    for (const block of messages.flatMap((m) => m.content)) {
      if (block.type !== "tool_result") continue;
      for (const m of block.content.matchAll(/(?:textbox|button) "([^"]+)"[^\n]*@(e\d+)/g)) if (!refs.has(m[1]!)) refs.set(m[1]!, `@${m[2]}`);
    }
  };
  const refOf = (label: string): string => {
    const ref = refs.get(label);
    if (!ref) throw new Error(`no ref for ${label} in ${[...refs.keys()].join(", ")}`);
    return ref;
  };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-leak-fill-"));
    site = createServer(answer);
    pay = createServer(answer);
    for (const s of [site, pay]) await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    // http://localhost is the one plain-http origin a secret may be used on; the frame's port makes it another origin.
    base = `http://localhost:${(site.address() as { port: number }).port}`;
    payBase = `http://localhost:${(pay.address() as { port: number }).port}`;
    vault = new Vault({ dir: join(root, "vault") });
    await vault.init();
    password = `pw-${rand(20)}`;
    card = luhnCard();
    const login = vault.add({ label: "Shop login", kind: "login", values: { username: "owner", password }, use: { web: { origins: [base] } } });
    const visa = vault.add({ label: "Visa", kind: "card", values: { number: card, expiry: "04/29" }, use: { web: { origins: [base], frames: [payBase] } } });
    code = rand(8).toUpperCase();
    canaries = [password, card, code];
    const secrets = new SecretsRegistry();
    secrets.attachVault(vault);

    const inference: Inference = {
      async generate(_task, request) {
        requests.push(JSON.parse(JSON.stringify(request)) as GenerateRequest);
        if (!request.tools?.some((t) => t.name === "secrets.fill")) return step([{ type: "text", text: "ok" }], "end_turn");
        const done = request.messages.flatMap((m) => m.content).filter((b) => b.type === "tool_result").length;
        readRefs(request.messages);
        const call = (input: Record<string, unknown>, name: string): ModelResponse => step([{ type: "tool_use", id: `leak-${done + 1}`, name, input }]);
        switch (done) {
          case 0:
            return call({ url: `${base}/`, wait: "load" }, "browser.visit");
          case 1:
            return call({}, "secrets.list");
          case 2:
            return call({ secret: login, fields: [{ field: "username", target: refOf("Username") }, { field: "password", target: refOf("Password") }], intent: "sign in" }, "secrets.fill");
          case 3:
            return call({ secret: visa, fields: [{ field: "number", target: refOf("Card number") }], intent: "pay" }, "secrets.fill");
          case 4:
            return call({ secret: "code", fields: [{ field: "code", target: refOf("One-time code") }], intent: "finish signing in" }, "secrets.fill");
          case 5:
            // The page's own show-password toggle, which turns the field into plain text.
            return call({ actions: [{ click: refOf("Show password") }], intent: "show the password" }, "browser.act");
          case 6:
            return call({}, "browser.look");
          case 7:
            return call({ then: "snapshot" }, "browser.look");
          case 8:
            return call({ then: "read" }, "browser.look");
          case 9:
            return call({ code: "document.getElementById('pw').value" }, "browser.eval");
          case 10:
            // A script as an address, which would run in the page that holds the secret.
            return call({ actions: [{ open: "javascript:document.title=document.getElementById('pw').value" }], intent: "read the field" }, "browser.act");
          default:
            return step([{ type: "text", text: "Signed in and the card is in." }], "end_turn");
        }
      },
    };
    const port = await freePort();
    kernel = await Kernel.boot({
      rootDir: join(root, "ws"),
      secrets,
      inference,
      profileOverrides: { name: "Kenny", timezone: "UTC" },
      chrome: { port },
    });
    kernel.progress.subscribe((event) => events.push(JSON.parse(JSON.stringify(event)) as ProgressEvent));
    for (const stream of [process.stdout, process.stderr]) {
      const write = stream.write.bind(stream);
      vi.spyOn(stream, "write").mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
        printed.push(String(chunk));
        return (write as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof stream.write);
    }
  }, 60_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await kernel?.closeBrowser();
    kernel?.close();
    for (const s of [site, pay]) {
      s?.closeAllConnections();
      s?.close();
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const leaks = (text: string): string[] => {
    const digitsOnly = text.replace(/[ .-]/g, "");
    return canaries.filter((c) => needlesOf(c).some((form) => text.includes(form)) || (/^\d+$/.test(c) && digitsOnly.includes(c)));
  };

  it("fills, looks and is refused a script, and keeps no value anywhere", async () => {
    const chat = kernel.conversations.create({ userId: kernel.profile.ownerId, channel: "dashboard" });
    // The owner approves each ask from the dashboard as it comes.
    const decided = new Set<number>();
    const approver = setInterval(() => {
      for (const ask of kernel.approvals.pending()) {
        if (decided.has(ask.id)) continue;
        decided.add(ask.id);
        void kernel.approve(ask.id, kernel.profile.ownerId, { surface: "dashboard", ...(ask.secret?.code ? { code } : {}) });
      }
    }, 50);
    const said = `Sign me in at ${base} and put my card ${card.match(/.{4}/g)!.join(" ")} in.`;
    expect(leaks(said)).toHaveLength(1);
    const res = await kernel.handleMessage(said, { owner: true, sessionId: chat.id });
    // The turn holds on each ask in the background, as a dashboard turn does, and carries on once it is approved.
    await vi.waitFor(() => expect(requests.some((r) => JSON.stringify(r.messages).includes('"toolUseId":"leak-11"'))).toBe(true), { timeout: 90_000, interval: 200 });
    await vi.waitFor(() => expect(events.some((e) => e.kind === "turn-end" && e.conversationId === res.sessionId)).toBe(true), { timeout: 30_000, interval: 200 });
    clearInterval(approver);

    // It did what was asked: both filled, the script refused, every use recorded.
    const sent = JSON.stringify(requests);
    expect(sent).toContain("Filled username and password from Shop login");
    expect(sent).toContain("Filled card number from Visa");
    expect(sent).toMatch(/Filled the one-time code \(otp_[0-9a-f]{8}\) on http:\/\/localhost:\d+, in KOS's own browser/);
    expect(sent).toContain('textbox \\"Password\\" = \\"(hidden)\\"');
    expect(sent).toContain("browser.eval is refused: a secret was filled into this page");
    expect(sent).toContain("javascript: addresses are not opened");
    expect(sent).toMatch(/clicked @e\d+/);
    expect(vault.list().flatMap((s) => kernel.secretUses.list(s.handle).map((u) => `${s.label}:${u.outcome}`)).sort()).toEqual(["Shop login:filled", "Visa:filled"]);

    // The model was sent no value, in words or pictures: every tool result, every request.
    expect(leaks(sent)).toEqual([]);
    expect(leaks(JSON.stringify(events))).toEqual([]);
    expect(leaks(JSON.stringify(kernel.sessions.get(res.sessionId!)))).toEqual([]);
    const db = kernel.workspace.db;
    for (const { name } of db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]) {
      const text = JSON.stringify(db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).raw().all(), (_k, v: unknown) => (Buffer.isBuffer(v) ? v.toString("utf8") : typeof v === "bigint" ? String(v) : v));
      expect({ table: name, leaks: leaks(text) }).toEqual({ table: name, leaks: [] });
    }
    const messages = await handleApiRequest(kernel, { method: "GET", path: `/api/conversations/${encodeURIComponent(res.sessionId!)}/messages` });
    expect(leaks(JSON.stringify(messages.body))).toEqual([]);
    expect(leaks(printed.join(""))).toEqual([]);

    // No picture shows what was typed: the ones the model was sent and the ones KOS kept, counted on a page with no secret.
    const sentPictures = requests.flatMap((r) => r.messages.flatMap((m) => m.content.flatMap((b) => (b.type === "tool_result" ? (b.images ?? []).map((i) => i.data) : []))));
    const kept = (db.prepare(`SELECT picture FROM browser_frames`).all() as { picture: string }[]).map((r) => r.picture);
    expect(sentPictures.length).toBeGreaterThan(0);
    const probe = await kernel.browser.page(await kernel.browser.tabFor("leak-probe"));
    await probe.ready();
    for (const jpeg of [...new Set([...sentPictures, ...kept])]) {
      const magenta = Number(
        await probe.evaluate(`await (async () => {
          const img = new Image(); img.src = "data:image/jpeg;base64,${jpeg}"; await img.decode();
          const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
          const g = c.getContext("2d"); g.drawImage(img, 0, 0);
          const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0;
          for (let i = 0; i < d.length; i += 4) if (d[i] > 190 && d[i + 1] < 90 && d[i + 2] > 190) n++;
          return n;
        })()`),
      );
      expect(magenta).toBeLessThan(20);
    }
  });
});
