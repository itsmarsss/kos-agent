import { KOS_SEED, drawingOf, lookOf } from "@kos/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isPrivatePath, kosAddress, parsePairing, socketUrl } from "./address.js";
import { CallError, deviceProof, fromBase64, hostProof, readFrame, toBase64 } from "./protocol.js";
import { Link, said, type Hello, type LinkState } from "./link.js";
import { Lines } from "./lines.js";
import { linkWords, needsPairing, type LineOf } from "./linkwords.js";
import { installOverlay } from "./overlay.js";
import { adding, readPairings, removing, replacedBy, type Paired } from "./pairings.js";
import { checkCommand, forwarded, isWebUrl, Worlds } from "./relay.js";
import { GRACE_MS, Session } from "./session.js";
import { DEFAULTS, DEFAULT_HIDDEN, asksFirst, isHidden, readSettings, siteOf } from "./settings.js";

/**
 * The parts of the extension that keep the owner's Chrome theirs: where it
 * will connect, what it passes on to a tab, and whose hand is on the page.
 */

describe("where the extension connects", () => {
  it("goes to KOS encrypted: https anywhere, plain http only to this computer or a tailnet", () => {
    expect(kosAddress("https://kos.example.com/settings")).toBe("https://kos.example.com");
    expect(kosAddress("127.0.0.1:4317")).toBe("http://127.0.0.1:4317");
    expect(kosAddress("kos.tail1234.ts.net")).toBe("http://kos.tail1234.ts.net");
    expect(kosAddress("kos.example.com")).toBe("https://kos.example.com");
    expect(() => kosAddress("http://kos.example.com")).toThrow(/Plain http only works/);
    expect(() => kosAddress("https://me:pw@kos.example.com")).toThrow(/name and password/);
    expect(isPrivatePath("100.101.2.3")).toBe(true);
    expect(isPrivatePath("100.200.2.3")).toBe(false);
    expect(isPrivatePath("[::1]")).toBe(true);
    expect(socketUrl("https://kos.example.com")).toBe("wss://kos.example.com/api/devices/socket");
    expect(socketUrl("http://127.0.0.1:4317")).toBe("ws://127.0.0.1:4317/api/devices/socket");
  });

  it("reads the dashboard's pairing link, and refuses anything else", () => {
    expect(parsePairing("kos-device://pair?url=http%3A%2F%2F127.0.0.1%3A4317&code=k7qx-m2pa")).toEqual({ url: "http://127.0.0.1:4317", code: "K7QX-M2PA" });
    expect(() => parsePairing("https://kos.example.com/pair?code=X")).toThrow(/not a KOS pairing link/);
    expect(() => parsePairing("K7QX-M2PA")).toThrow(/Paste the link/);
    expect(() => parsePairing("kos-device://pair?url=http%3A%2F%2Fkos.example.com&code=X")).toThrow(/Plain http/);
  });
});

describe("the protocol", () => {
  it("signs what KOS for Mac signs, and reads only KOS's frames", () => {
    expect(deviceProof("bm9uY2U=", "dev_1")).toBe("kos-device/1|device|bm9uY2U=|dev_1");
    expect(hostProof("bm9uY2U=", "dev_1")).toBe("kos-device/1|host|bm9uY2U=|dev_1");
    expect(toBase64(fromBase64("AAEC/w=="))).toBe("AAEC/w==");
    expect(readFrame('{"t":"call","id":3,"method":"tabs.list","params":{"session":"s"}}')).toEqual({ t: "call", id: 3, method: "tabs.list", params: { session: "s" } });
    expect(readFrame('{"t":"call","id":"3","method":"x"}')).toBeUndefined();
    expect(readFrame('{"t":"pong"}')).toEqual({ t: "pong" });
    // KOS's face, decided there: read whole, or not at all.
    const face = drawingOf(lookOf(KOS_SEED, { shape: "mochi", eyes: "sparkle" }));
    expect(readFrame(JSON.stringify({ t: "face", face }))).toEqual({ t: "face", face });
    expect(readFrame(JSON.stringify({ t: "face", face: { ...face, fill: "blue" } }))).toBeUndefined();
    expect(readFrame(JSON.stringify({ t: "face", face: { ...face, shape: { ...face.shape, lobes: [{ k: 2.5, amp: 0.1, phase: 0 }] } } }))).toBeUndefined();
    expect(readFrame("not json")).toBeUndefined();
  });
});

describe("what reaches a tab", () => {
  it("passes on the commands KOS's hands use, and refuses the rest", () => {
    expect(() => checkCommand("Runtime.evaluate", { expression: "1" })).not.toThrow();
    expect(() => checkCommand("Input.dispatchMouseEvent", {})).not.toThrow();
    for (const method of ["Network.getAllCookies", "Storage.getCookies", "Target.createTarget", "Browser.close", "Page.setDownloadBehavior", "Network.setCookie", "Debugger.enable"]) {
      expect(() => checkCommand(method, {})).toThrow(CallError);
    }
  });

  it("navigates only to the web", () => {
    expect(() => checkCommand("Page.navigate", { url: "https://example.com" })).not.toThrow();
    for (const url of ["file:///etc/passwd", "chrome://settings", "chrome-extension://abc/popup.html", "javascript:alert(1)", "data:text/html,hi"]) {
      expect(() => checkCommand("Page.navigate", { url })).toThrow(/only web pages/);
    }
    expect(isWebUrl("about:blank")).toBe(true);
  });

  it("lets KOS make only its hands' own world, with no more reach than the page", () => {
    expect(() => checkCommand("Page.createIsolatedWorld", { frameId: "f", worldName: "kos-hands" })).not.toThrow();
    expect(() => checkCommand("Page.createIsolatedWorld", { frameId: "f", worldName: "kos-hands", grantUniveralAccess: false })).not.toThrow();
    // The overlay's world, whose binding says Take over, Hand back and Stop for the owner.
    expect(() => checkCommand("Page.createIsolatedWorld", { frameId: "f", worldName: "kos" })).toThrow(CallError);
    expect(() => checkCommand("Page.createIsolatedWorld", { frameId: "f" })).toThrow(CallError);
    expect(() => checkCommand("Page.createIsolatedWorld", { frameId: "f", worldName: "kos-hands", grantUniveralAccess: true })).toThrow(CallError);
  });

  /** A tab's worlds as Chrome told of them: the page's (3, u3), KOS's hands' (5), the overlay's (7, u7) and another extension's (8). */
  const tabWorlds = (): Worlds => {
    const worlds = new Worlds();
    worlds.made({ id: 3, uniqueId: "u3", name: "", auxData: { isDefault: true } });
    worlds.made({ id: 5, uniqueId: "u5", name: "kos-hands", auxData: { isDefault: false } });
    worlds.made({ id: 7, uniqueId: "u7", name: "kos", auxData: { isDefault: false } });
    worlds.made({ id: 8, uniqueId: "u8", name: "Some Extension", auxData: { isDefault: false } });
    return worlds;
  };

  it("runs KOS's script only in the page's world and its hands', never the overlay's", () => {
    const worlds = tabWorlds();
    expect(() => worlds.check({ expression: "1", contextId: 3 })).not.toThrow();
    expect(() => worlds.check({ expression: "1", contextId: 5 })).not.toThrow();
    expect(() => worlds.check({ expression: "1" })).not.toThrow();
    expect(() => worlds.check({ expression: "kosOverlay('{\"kind\":\"handback\"}')", contextId: 7 })).toThrow(/overlay/);
    expect(() => worlds.check({ expression: "1", uniqueContextId: "u7" })).toThrow(/overlay/);
    expect(() => worlds.check({ functionDeclaration: "() => 1", executionContextId: 7 })).toThrow(/overlay/);
    expect(() => worlds.check({ expression: "1", contextId: 8 })).toThrow(/neither the page's nor KOS's own/);
    expect(worlds.isOverlay(7)).toBe(true);
    expect(worlds.isOverlay(3)).toBe(false);
  });

  it("refuses a world it has not heard Chrome make, and says one gone is gone", () => {
    const worlds = tabWorlds();
    // An overlay made a moment before the worker heard of it is refused, not let through as not known to be the overlay's.
    expect(worlds.heard({ contextId: 9 })).toBe(false);
    expect(() => worlds.check({ expression: "1", contextId: 9 })).toThrow(/not one Chrome has said this tab holds/);
    expect(() => worlds.check({ objectId: "4087261833316862514.9.1" })).toThrow(/not one Chrome has said this tab holds/);
    expect(() => worlds.check({ expression: "1", uniqueContextId: "u9" })).toThrow(/not one Chrome has said this tab holds/);
    worlds.made({ id: 9, name: "kos-hands" });
    expect(worlds.heard({ contextId: 9 })).toBe(true);
    expect(() => worlds.check({ expression: "1", contextId: 9 })).not.toThrow();
    // Gone with its document: heard of, and refused at once as Chrome would.
    worlds.destroyed(9);
    expect(worlds.heard({ contextId: 9 })).toBe(true);
    expect(() => worlds.check({ contextId: 9 })).toThrow(expect.objectContaining({ code: "cdp", message: expect.stringMatching(/gone/) }));
    worlds.cleared();
    expect(() => worlds.check({ contextId: 3 })).toThrow(/gone/);
    expect(() => worlds.check({ uniqueContextId: "u3" })).toThrow(/not one Chrome has said/);
  });

  it("reads each name a command may give a world by alone, so one cannot hide another", () => {
    const worlds = tabWorlds();
    // callFunctionOn reads executionContextId and ignores contextId: a string there once let the overlay's id through.
    expect(() => worlds.check({ functionDeclaration: "() => 1", contextId: "x", executionContextId: 7 })).toThrow(CallError);
    expect(() => worlds.check({ functionDeclaration: "() => 1", contextId: 3, executionContextId: 7 })).toThrow(/overlay/);
    expect(() => worlds.check({ expression: "1", contextId: 3, uniqueContextId: "u7" })).toThrow(/overlay/);
    expect(() => worlds.check({ functionDeclaration: "() => 1", uniqueContextId: "u7" })).toThrow(/overlay/);
    // A name of the wrong type is refused rather than passed on to be read some other way.
    expect(() => worlds.check({ expression: "1", contextId: "7" })).toThrow(CallError);
    expect(() => worlds.check({ expression: "1", uniqueContextId: 7 })).toThrow(CallError);
    expect(() => worlds.check({ expression: "1", contextId: 3, uniqueContextId: "u3" })).not.toThrow();
  });

  it("makes and reaches no object outside the page's world and its hands'", () => {
    const worlds = tabWorlds();
    // A node resolved into the overlay's world is an object there, which a function called on it would run in.
    expect(() => worlds.check({ backendNodeId: 5, executionContextId: 7 })).toThrow(/overlay/);
    expect(() => worlds.check({ backendNodeId: 5, executionContextId: 3, objectGroup: "kos" })).not.toThrow();
    expect(() => worlds.check({ backendNodeId: 5 })).not.toThrow();
    // An object's id names its world (isolate.world.object): one of the overlay's is refused, whatever command takes it.
    expect(() => worlds.check({ objectId: "-4087261833316862514.7.12", functionDeclaration: "function () { kosOverlay('{\"kind\":\"handback\"}') }" })).toThrow(/overlay/);
    expect(() => worlds.check({ objectId: "4087261833316862514.3.12", functionDeclaration: "function () {}" })).not.toThrow();
    expect(() => worlds.check({ objectId: "4087261833316862514.5.12" })).not.toThrow();
    expect(() => worlds.check({ objectId: 7, functionDeclaration: "function () {}" })).toThrow(CallError);
    expect(() => worlds.check({ objectId: "not-an-id" })).toThrow(/names no world/);
  });

  it("tells KOS only what its hands listen for", () => {
    const open = new Set<string>();
    expect(forwarded("Page.lifecycleEvent", { name: "load" }, open)).toEqual({ name: "load" });
    expect(forwarded("Page.navigatedWithinDocument", { frameId: "F", url: "https://shop.example/cart" }, open)).toEqual({ frameId: "F", url: "https://shop.example/cart" });
    expect(forwarded("Network.responseReceivedExtraInfo", {}, open)).toBeUndefined();
    expect(forwarded("Runtime.consoleAPICalled", {}, open)).toBeUndefined();
    // Of the network, only the requests a page's answer waits on, without their headers, and the end of only those.
    // Dated by both the browser's clocks: the one that stands still while the computer sleeps, and the wall's.
    const sent = { requestId: "1", type: "Fetch", timestamp: 812.5, wallTime: 1_762_600_000.25, request: { url: "https://shop.example/api", headers: { cookie: "x" } }, initiator: { type: "script" } };
    expect(forwarded("Network.requestWillBeSent", sent, open)).toStrictEqual({ requestId: "1", type: "Fetch", timestamp: 812.5, wallTime: 1_762_600_000.25, request: { url: "https://shop.example/api" } });
    expect(forwarded("Network.requestWillBeSent", { requestId: "2", type: "Image", request: { url: "https://shop.example/a.png" } }, open)).toBeUndefined();
    expect(forwarded("Network.loadingFinished", { requestId: "2" }, open)).toBeUndefined();
    expect(forwarded("Network.loadingFinished", { requestId: "1", encodedDataLength: 9 }, open)).toEqual({ requestId: "1" });
    expect(forwarded("Network.loadingFailed", { requestId: "1" }, open)).toBeUndefined();
  });
});

describe("a session", () => {
  const info = { id: "s1", task: "book a table", requester: "Dinner", until: 10_000 };

  it("ends at its time, or when nothing has asked of it for a while", () => {
    const session = new Session(info, 0);
    expect(session.over(1_000, 5_000)).toBeUndefined();
    expect(session.over(6_000, 5_000)).toBe("idle");
    session.touch(6_000);
    expect(session.over(7_000, 5_000)).toBeUndefined();
    expect(session.over(10_000, 5_000)).toBe("expired");
  });

  it("never idles while the owner has it, and starts its idle clock again when they hand it back", () => {
    const session = new Session(info, 0);
    session.pause();
    expect(session.over(9_000, 5_000)).toBeUndefined();
    session.resume(9_000);
    expect(session.over(9_500, 5_000)).toBeUndefined();
    expect(session.over(10_000, 5_000)).toBe("expired");
  });

  it("does not take the owner's hand for a takeover in the moment after they allow it or hand it back", () => {
    const session = new Session(info, 0);
    expect(session.inGrace(GRACE_MS - 1)).toBe(true);
    expect(session.inGrace(GRACE_MS)).toBe(false);
    session.pause();
    session.resume(5_000);
    expect(session.inGrace(5_000 + GRACE_MS - 1)).toBe(true);
    expect(session.inGrace(5_000 + GRACE_MS)).toBe(false);
  });

  it("knows KOS's own clicks and keys when the page reports them, and the owner's when it did not send them", () => {
    const session = new Session(info, 0);
    session.dispatching("Input.dispatchMouseEvent", { type: "mousePressed", x: 100.5, y: 40 }, 0);
    session.dispatching("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter" }, 0);
    expect(session.isOwners({ type: "pointerdown", x: 101, y: 40 }, 50)).toBe(false);
    expect(session.isOwners({ type: "keydown", key: "Enter" }, 60)).toBe(false);
    // The same click again is not KOS's: each of its own is matched once.
    expect(session.isOwners({ type: "pointerdown", x: 101, y: 40 }, 70)).toBe(true);
    expect(session.isOwners({ type: "keydown", key: "a" }, 80)).toBe(true);
    // KOS's input is remembered only for a moment.
    session.dispatching("Input.dispatchMouseEvent", { type: "mousePressed", x: 5, y: 5 }, 100);
    expect(session.isOwners({ type: "pointerdown", x: 5, y: 5 }, 5_000)).toBe(true);
  });
});

describe("the look", () => {
  it("draws KOS's face over a page in the colours the dashboard and the app give it", () => {
    const kos = lookOf(KOS_SEED);
    const source = installOverlay.toString();
    expect(source).toContain(kos.fill);
    expect(source).toContain(kos.ink);
  });
});

describe("the owner's settings", () => {
  it("reads what was stored, and is the default for anything missing or not a choice", () => {
    expect(readSettings(undefined)).toEqual(DEFAULTS);
    // Clicks and keys take a tab over; scrolling does not, unless the owner says so.
    expect(DEFAULTS.takeover).toBe("clicksAndKeys");
    expect(readSettings({ takeover: "anyInput" }).takeover).toBe("anyInput");
    expect(readSettings({ takeover: "wheel" }).takeover).toBe("clicksAndKeys");
    const s = readSettings({ longestMinutes: 240, promptWaitSeconds: 7, idleMinutes: 3, takeover: "clicksAndKeys", timeOnIcon: false, askFirst: { dev_a: false, dev_b: "no" } });
    expect(s).toMatchObject({ longestMinutes: 240, promptWaitSeconds: 60, idleMinutes: 3, takeover: "clicksAndKeys", connectOnStart: true, timeOnIcon: false, askFirst: { dev_a: false } });
    expect(asksFirst(s, "dev_a")).toBe(false);
    expect(asksFirst(s, "dev_new")).toBe(true);
  });

  it("hides a site with every subdomain, however the owner typed it", () => {
    expect(siteOf("https://www.Chase.com/login?x=1")).toBe("chase.com");
    expect(siteOf("*.bank.example")).toBe("bank.example");
    expect(siteOf("my.1password.com")).toBe("my.1password.com");
    expect(siteOf("not a site")).toBeUndefined();
    const sites = readSettings({ hiddenSites: ["chase.com", "Chase.com", "junk value", 4] }).hiddenSites;
    expect(sites).toEqual(["chase.com"]);
    expect(isHidden("https://secure.chase.com/x", sites)).toBe(true);
    expect(isHidden("https://chase.com", sites)).toBe(true);
    expect(isHidden("https://notchase.com", sites)).toBe(false);
    expect(isHidden("about:blank", sites)).toBe(false);
    expect(isHidden("https://my.1password.com/vault", DEFAULT_HIDDEN)).toBe(true);
  });
});

describe("the KOS this Chrome is paired with", () => {
  const home = { url: "http://127.0.0.1:4317", device: "d1", hostKey: "k", name: "Chrome" };
  const work = { url: "https://kos.work.ts.net", device: "d2", hostKey: "k", name: "Chrome" };

  it("reads the list, or the one pairing an older version kept", () => {
    expect(readPairings([home, { url: 1 }], undefined)).toEqual([home]);
    expect(readPairings(undefined, home)).toEqual([home]);
    expect(readPairings(undefined, undefined)).toEqual([]);
    // The face a KOS last sent is kept with it; one that does not read is dropped, the pairing kept.
    const face = drawingOf(lookOf(KOS_SEED, { shape: "cloud" }));
    expect(readPairings([{ ...home, face }], undefined)).toEqual([{ ...home, face }]);
    expect(readPairings([{ ...home, face: { fill: 1 } }], undefined)).toEqual([home]);
  });

  it("adds another KOS after the rest, and pairing one again replaces it in place", () => {
    expect(adding(work, [home])).toEqual([home, work]);
    const again = { ...home, url: "http://127.0.0.1:4317/", device: "d3" };
    expect(replacedBy(again, [home, work])).toEqual([home]);
    expect(adding(again, [home, work])).toEqual([again, work]);
    expect(adding({ ...work, url: home.url }, [home, work])).toEqual([{ ...work, url: home.url }]);
    expect(removing("d1", [home, work])).toEqual([work]);
  });
});

describe("a KOS's line in words", () => {
  const line = (over: Partial<LineOf>): LineOf => ({ host: "127.0.0.1:4317", name: "Chrome on macOS", link: "online", held: false, askFirst: true, ...over });

  it("says KOS's own reason for turning this Chrome away, as a sentence, and a fallback when it gave none", () => {
    expect(said("unknown device: KOS has no device by this id; pair again", "x")).toBe("Unknown device: KOS has no device by this id; pair again.");
    expect(said("removed from KOS", "x")).toBe("Removed from KOS.");
    expect(said("Already a sentence.", "x")).toBe("Already a sentence.");
    expect(said("  ", "KOS gave no reason.")).toBe("KOS gave no reason.");
  });

  it("names each state precisely, and offers pairing again only where that is the fix", () => {
    expect(linkWords(line({}))).toEqual({ word: "Connected", tone: "ok", detail: "As Chrome on macOS · asks here first" });
    expect(linkWords(line({ link: "connecting" })).word).toBe("Connecting");
    expect(linkWords(line({ link: "offline" }))).toMatchObject({ word: "Can't reach KOS", detail: "No answer from 127.0.0.1:4317. Trying again." });
    const unpaired = line({ link: "unpaired", detail: "Bad signature: not signed by the key this device paired with; pair again." });
    expect(linkWords(unpaired)).toMatchObject({ word: "Not paired", tone: "danger", detail: unpaired.detail });
    expect(needsPairing(unpaired)).toBe(true);
    expect(linkWords(line({ link: "refused", detail: "Another copy of this extension connected to KOS in its place." })).word).toBe("Refused");
    expect(needsPairing(line({ link: "refused" }))).toBe(false);
    // Held by the owner, whatever its line last was: paused, and nothing to pair.
    expect(linkWords(line({ link: "unpaired", held: true })).word).toBe("Paused");
    expect(needsPairing(line({ link: "unpaired", held: true }))).toBe(false);
  });
});

describe("each KOS's line, opened once", () => {
  const paired = (device: string): Paired => ({ url: "http://127.0.0.1:4317", device, hostKey: "k", name: "Chrome" });
  const key = {} as CryptoKeyPair;
  function setup(over: { keysFor?: (id: string) => Promise<CryptoKeyPair | undefined> } = {}) {
    const held = new Set<string>();
    const states = new Map<string, { state: LinkState; detail?: string }>();
    const made: string[] = [];
    const dials: string[] = [];
    let reading: (() => void) | undefined;
    const lines = new Lines({
      keysFor: over.keysFor ?? (() => new Promise<CryptoKeyPair>((r) => (reading = () => r(key)))),
      link: (p) => {
        made.push(p.device);
        return { start: () => void dials.push(p.device) };
      },
      wanted: (id) => !held.has(id),
      stateOf: (id) => states.get(id)?.state,
      setState: (p, state, detail) => void states.set(p.device, { state, ...(detail ? { detail } : {}) }),
    });
    return { lines, held, states, made, dials, read: () => reading?.() };
  }

  it("dials once when the worker's start and its alarm both ask while the key is read", async () => {
    const { lines, made, dials, read } = setup();
    const first = lines.connect(paired("dev_a"));
    const second = lines.connect(paired("dev_a"));
    read();
    await Promise.all([first, second]);
    expect(made).toEqual(["dev_a"]);
    expect(dials).toEqual(["dev_a"]);
    // Asked again, the same link dials again; no second is made.
    await lines.connect(paired("dev_a"));
    expect(made).toEqual(["dev_a"]);
    expect(dials).toEqual(["dev_a", "dev_a"]);
  });

  it("does not open a line held while its key was read: Chrome opening with 'wait for Connect', or Disconnect pressed", async () => {
    const { lines, held, made, read } = setup();
    const opening = lines.connect(paired("dev_a"));
    held.add("dev_a");
    read();
    await opening;
    expect(made).toEqual([]);
    expect(lines.links.size).toBe(0);
  });

  it("says a missing key or one it cannot read, and goes on to the other KOS", async () => {
    const { lines, states, made } = setup({ keysFor: async (id) => (id === "dev_gone" ? undefined : id === "dev_broken" ? Promise.reject(new Error("the key store did not open")) : key) });
    await lines.connectAll([paired("dev_broken"), paired("dev_gone"), paired("dev_ok")]);
    expect(states.get("dev_broken")).toEqual({ state: "error", detail: "This Chrome could not read its key: the key store did not open" });
    expect(states.get("dev_gone")).toEqual({ state: "unpaired", detail: "This Chrome no longer has the key it paired with. Pair again." });
    expect(made).toEqual(["dev_ok"]);
  });

  it("leaves a line KOS no longer takes to the owner: the minute's round skips it, Try now or a changed setting dials it", async () => {
    const { lines, states, dials } = setup({ keysFor: async () => key });
    await lines.connect(paired("dev_a"));
    states.set("dev_a", { state: "unpaired" });
    await lines.connectAll([paired("dev_a")]);
    expect(dials).toEqual(["dev_a"]);
    await lines.connectAll([paired("dev_a")], true);
    await lines.connect(paired("dev_a"));
    expect(dials).toEqual(["dev_a", "dev_a", "dev_a"]);
  });
});

describe("a line KOS closes", () => {
  class FakeSocket {
    static made: FakeSocket[] = [];
    static readonly OPEN = 1;
    readyState = 0;
    onmessage: ((e: MessageEvent<string>) => void) | null = null;
    onclose: ((e: { code: number; reason: string }) => void) | null = null;
    constructor(readonly url: string) {
      FakeSocket.made.push(this);
    }
    send(): void {}
    close(): void {}
  }
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    FakeSocket.made = [];
  });

  const closed = (code: number, reason: string) => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket);
    FakeSocket.made = [];
    const states: [LinkState, string | undefined][] = [];
    const link = new Link({ url: "http://127.0.0.1:4317", device: "dev_a", hostKey: "k", keys: {} as CryptoKeyPair, hello: () => ({}) as Hello, onCall: async () => ({}), onFace: () => undefined, onState: (s, d) => void states.push([s, d]) });
    link.start();
    FakeSocket.made[0]!.onclose!({ code, reason });
    vi.advanceTimersByTime(1_000);
    return { states, dials: FakeSocket.made.length };
  };

  it("dials again, later each time, after any close but a refusal for good, and says KOS's reason meanwhile", () => {
    expect(closed(4001, "unreadable frame")).toEqual({ states: [["connecting", undefined], ["offline", "Unreadable frame. Trying again."], ["connecting", undefined]], dials: 2 });
    expect(closed(1006, "").dials).toBe(2);
  });

  it("waits for the owner after KOS does not take its pairing, or speaks another protocol", () => {
    expect(closed(4003, "unknown device: KOS has no device by this id; pair again")).toEqual({ states: [["connecting", undefined], ["unpaired", "Unknown device: KOS has no device by this id; pair again."]], dials: 1 });
    expect(closed(4010, "protocol version: KOS speaks protocol 2; update this app")).toMatchObject({ states: [["connecting", undefined], ["refused", "Protocol version: KOS speaks protocol 2; update this app."]], dials: 1 });
  });
});
