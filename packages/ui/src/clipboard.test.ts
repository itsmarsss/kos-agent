import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every place a web page of KOS's writes the clipboard (the dashboard, the
 * kit, KOS for Chrome), each with what it copies. A page writes plain text
 * alone: it cannot mark a copy concealed or transient, so a clipboard
 * history app keeps it. None of these copies a secret's value, and none
 * may: a new copy fails here until it is looked at and listed.
 */
const COPIES: Record<string, string> = {
  "browser-extension/src/popup.tsx": "KOS for Chrome's own log, to send when something went wrong",
  "kit/src/AskCard.tsx": "an ask's arguments, scrubbed by the host",
  "kit/src/CodeBlock.tsx": "a code block from a reply",
  "kit/src/KosBlock.tsx": "a draft KOS wrote",
  "ui/pagelib/docedit.ts": "the owner's selection in a document",
  "ui/src/App.tsx": "the workspace's folder",
  "ui/src/ChatsPage.tsx": "the owner's own queued message",
  "ui/src/DevicesPanel.tsx": "a one-use pairing code or link, minutes long",
  "ui/src/finder/ops.ts": "a file's path",
  "ui/src/kit.tsx": "a command to run in Terminal",
  "ui/src/Lightbox.tsx": "a step's picture",
  "ui/src/MessageActions.tsx": "a message's words",
};

const packages = fileURLToPath(new URL("../..", import.meta.url));
const ROOTS = ["ui/src", "ui/pagelib", "kit/src", "browser-extension/src"];
/** What writes a clipboard from a page: the async API, or the old copy command. */
const WRITES = /navigator\.clipboard\??\s*\.\s*write|execCommand\(\s*["']copy["']\s*\)/;
/** What reads a secret's value into a page: the reveal route, and the vault's fill. */
const SECRET_VALUE = /\.reveal\(|\/reveal\b|secret\.fill\b/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" || name === "dist" ? [] : sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("KOS's copies onto the clipboard from a page", () => {
  const files = ROOTS.flatMap((root) => sources(join(packages, root))).map((path) => ({ path: relative(packages, path), text: readFileSync(path, "utf8") }));
  const writers = files.filter((f) => WRITES.test(f.text));

  it("are the ones listed, each looked at for what it copies", () => {
    expect(writers.map((f) => f.path).sort()).toEqual(Object.keys(COPIES).sort());
  });

  it("never copy a secret's value: no page that reads one writes the clipboard", () => {
    expect(files.some((f) => f.path === "ui/src/SecretSheet.tsx" && SECRET_VALUE.test(f.text))).toBe(true);
    expect(writers.filter((f) => SECRET_VALUE.test(f.text)).map((f) => f.path)).toEqual([]);
  });
});
