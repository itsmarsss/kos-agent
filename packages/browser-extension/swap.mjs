// Puts a finished build in place of the extension Chrome has loaded: dist.next
// becomes dist in two renames, so a build that fails leaves the loaded one whole,
// and Chrome never finds the folder half written. With --restore, run before a
// build, it first puts back a dist a stop between those renames left aside.
import { existsSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const [next, dist, old] = ["dist.next", "dist", "dist.old"].map((name) => join(root, name));

if (process.argv[2] === "--restore") {
  if (!existsSync(dist) && existsSync(old)) renameSync(old, dist);
} else {
  if (existsSync(dist)) renameSync(dist, old);
  renameSync(next, dist);
  rmSync(old, { recursive: true, force: true });
}
