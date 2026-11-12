#!/usr/bin/env node
/**
 * Stamps a build of a device app: `node packages/computer/dist/stamp.js
 * <chrome|mac|phone> [file]` writes the build's id, commit and time as JSON
 * to the file, or prints it. Run by each app's build (the extension's
 * package build, bundle.sh, the iPhone app's Xcode phase) on the checkout
 * this file sits in.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { BUILD_SOURCES, stampOf, type BuildKind } from "./builds.js";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const [kind, out] = process.argv.slice(2);

if (!kind || !(kind in BUILD_SOURCES)) {
  console.error(`usage: stamp.js <${Object.keys(BUILD_SOURCES).join("|")}> [file]`);
  process.exit(2);
}
const build = stampOf(root, kind as BuildKind);
if (!build) {
  console.error(`stamp.js: nothing of ${kind} in ${root}`);
  process.exit(1);
}
const json = `${JSON.stringify(build)}\n`;
if (out) writeFileSync(out, json);
else process.stdout.write(json);
