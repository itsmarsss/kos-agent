import { KOS_SEED, lookOf } from "@kos/shared";
import { describe, expect, it } from "vitest";

import { isPrivatePath, kosAddress, parsePairing, socketUrl } from "./address.js";
import { CallError, deviceProof, fromBase64, hostProof, readFrame, toBase64 } from "./protocol.js";
import { installOverlay } from "./overlay.js";
import { checkCommand, forwards, isWebUrl } from "./relay.js";
import { Session } from "./session.js";

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
  it("signs what KOS Device signs, and reads only KOS's frames", () => {
    expect(deviceProof("bm9uY2U=", "dev_1")).toBe("kos-device/1|device|bm9uY2U=|dev_1");
    expect(hostProof("bm9uY2U=", "dev_1")).toBe("kos-device/1|host|bm9uY2U=|dev_1");
    expect(toBase64(fromBase64("AAEC/w=="))).toBe("AAEC/w==");
    expect(readFrame('{"t":"call","id":3,"method":"tabs.list","params":{"session":"s"}}')).toEqual({ t: "call", id: 3, method: "tabs.list", params: { session: "s" } });
    expect(readFrame('{"t":"call","id":"3","method":"x"}')).toBeUndefined();
    expect(readFrame('{"t":"pong"}')).toEqual({ t: "pong" });
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

  it("tells KOS only what its hands listen for", () => {
    expect(forwards("Page.lifecycleEvent")).toBe(true);
    expect(forwards("Network.responseReceivedExtraInfo")).toBe(false);
    expect(forwards("Runtime.consoleAPICalled")).toBe(false);
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
