import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BUILD_SOURCES, buildFiles, buildId, readBuild, readStamp, sourceBuild, stampOf } from "./builds.js";

let root = "";
const write = (path: string, text: string): void => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};

/** A checkout holding a little of each app, and some of KOS beside them. */
function checkout(): void {
  root = mkdtempSync(join(tmpdir(), "builds-test-"));
  write("packages/device-macos/Package.swift", "// swift-tools-version:5.10\n");
  write("packages/device-macos/Sources/KOSDevice/App.swift", "print(1)\n");
  write("packages/device-macos/Tests/DeviceUITests/A.swift", "test\n");
  write("packages/device-shared/Sources/DeviceCore/Wire.swift", "let v = 1\n");
  write("packages/device-ios/Sources/PhoneCore/Phone.swift", "let p = 1\n");
  write("packages/browser-extension/dist/worker.js", "self.x = 1;\n");
  write("packages/harness/src/kernel.ts", "export {};\n");
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

describe("a build's id", () => {
  it("is the same for the same files, and changes when the app's own do", () => {
    checkout();
    const first = buildId(root, "mac");
    expect(first).toMatch(/^[0-9a-f]{12}$/);
    expect(buildId(root, "mac")).toBe(first);
    write("packages/device-macos/Sources/KOSDevice/App.swift", "print(2)\n");
    expect(buildId(root, "mac")).not.toBe(first);
  });

  it("keeps its id through a change that is not the app's: KOS's own code, its tests, a dot file", () => {
    checkout();
    const mac = buildId(root, "mac");
    const phone = buildId(root, "phone");
    write("packages/harness/src/kernel.ts", "export const changed = true;\n");
    write("packages/device-macos/Tests/DeviceUITests/A.swift", "a changed test\n");
    write("packages/device-macos/Sources/.DS_Store", "finder\n");
    write("packages/device-ios/Sources/PhoneCore/Phone.swift", "let p = 2\n");
    expect(buildId(root, "mac")).toBe(mac);
    // The phone's own source changed; the Mac's did not.
    expect(buildId(root, "phone")).not.toBe(phone);
  });

  it("counts the code both native apps share as each one's", () => {
    checkout();
    const [mac, phone] = [buildId(root, "mac"), buildId(root, "phone")];
    write("packages/device-shared/Sources/DeviceCore/Wire.swift", "let v = 2\n");
    expect(buildId(root, "mac")).not.toBe(mac);
    expect(buildId(root, "phone")).not.toBe(phone);
  });

  it("follows no links, and sees a file renamed", () => {
    checkout();
    const before = buildId(root, "mac");
    symlinkSync(join(root, "packages/harness/src/kernel.ts"), join(root, "packages/device-macos/Sources/KOSDevice/linked.ts"));
    expect(buildId(root, "mac")).toBe(before);
    rmSync(join(root, "packages/device-macos/Sources/KOSDevice/App.swift"));
    write("packages/device-macos/Sources/KOSDevice/Main.swift", "print(1)\n");
    expect(buildId(root, "mac")).not.toBe(before);
  });

  it("of KOS for Chrome is its built folder, its stamp left out", () => {
    checkout();
    const before = buildId(root, "chrome");
    write("packages/browser-extension/dist/build.json", JSON.stringify({ id: "0123456789ab", commit: "" }));
    expect(buildId(root, "chrome")).toBe(before);
    expect(buildFiles(root, "chrome")).toEqual(["packages/browser-extension/dist/worker.js"]);
    write("packages/browser-extension/dist/worker.js", "self.x = 2;\n");
    expect(buildId(root, "chrome")).not.toBe(before);
  });

  it("is none for an app the checkout does not hold", () => {
    checkout();
    rmSync(join(root, "packages/browser-extension"), { recursive: true });
    expect(buildId(root, "chrome")).toBeUndefined();
    expect(sourceBuild(root, "chrome")).toBeUndefined();
  });

  it("sorts its files as bytes, so any language gets the same id", () => {
    checkout();
    write("packages/device-macos/Sources/KOSDevice/a.swift", "");
    write("packages/device-macos/Sources/KOSDevice/B.swift", "");
    const files = buildFiles(root, "mac");
    expect(files.indexOf("packages/device-macos/Sources/KOSDevice/B.swift")).toBeLessThan(files.indexOf("packages/device-macos/Sources/KOSDevice/a.swift"));
    expect(Object.keys(BUILD_SOURCES)).toEqual(["chrome", "mac", "phone"]);
  });
});

describe("a stamp", () => {
  it("carries the id, the commit (none outside a git checkout) and when it was built", () => {
    checkout();
    expect(stampOf(root, "phone", 1_700_000_000_000)).toEqual({ id: buildId(root, "phone"), commit: "", builtAt: 1_700_000_000_000 });
  });

  it("reads back from its file, and anything malformed is no build", () => {
    checkout();
    const commit = "a".repeat(40);
    write("stamp.json", JSON.stringify({ id: "0123456789ab", commit, builtAt: 5 }));
    expect(readStamp(join(root, "stamp.json"))).toEqual({ id: "0123456789ab", commit, builtAt: 5 });
    write("bad.json", "{");
    expect(readStamp(join(root, "bad.json"))).toBeUndefined();
    expect(readStamp(join(root, "none.json"))).toBeUndefined();
    expect(readBuild({ id: "XYZ", commit })).toBeUndefined();
    expect(readBuild({ id: "0123456789ab", commit: "short" })).toBeUndefined();
    expect(readBuild({ id: "0123456789ab", commit, builtAt: -1 })).toBeUndefined();
    expect(readBuild("0123456789ab")).toBeUndefined();
    expect(readBuild({ id: "0123456789ab", commit: "" })).toEqual({ id: "0123456789ab", commit: "" });
  });
});
