import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isInside, maskSecret, parseEnvFile, writeEnvFile } from "./envfile.js";

describe("the file secrets live in", () => {
  let root: string;
  let workspace: string;
  let envPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-env-"));
    workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    envPath = join(root, ".env");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("keeping secrets out of the workspace", () => {
    /*
     * The whole reason the jail stops the agent reading secrets is that they
     * are not in the workspace. A settings page that writes them inside would
     * put every key within reach of files.read, which the agent already has.
     */
    it("refuses to write inside the workspace", () => {
      for (const path of [
        join(workspace, ".env"),
        join(workspace, "nested", "deep", ".env"),
        workspace,
      ]) {
        expect(
          () => writeEnvFile(path, workspace, { OPENAI_API_KEY: "sk-nope" }),
          `${path} was accepted`,
        ).toThrow(/inside the workspace/);
      }
    });

    it("writes happily outside it", () => {
      writeEnvFile(envPath, workspace, { OPENAI_API_KEY: "sk-fine" });
      expect(readFileSync(envPath, "utf8")).toContain("sk-fine");
    });

    it("knows what is inside a directory and what merely looks like it", () => {
      expect(isInside("/a/b", "/a/b/c")).toBe(true);
      expect(isInside("/a/b", "/a/b")).toBe(true);
      // A sibling whose name starts with the same characters is not inside it.
      expect(isInside("/a/b", "/a/bc")).toBe(false);
      expect(isInside("/a/b", "/a")).toBe(false);
      expect(isInside("/a/b", "/a/b/../c")).toBe(false);
    });
  });

  describe("what may be written", () => {
    /*
     * A settings form that can set any variable can set PATH or NODE_OPTIONS,
     * and the next start would run whatever it pointed at. Only known keys.
     */
    it("ignores a key it does not know", () => {
      const result = writeEnvFile(envPath, workspace, {
        PATH: "/tmp/evil",
        NODE_OPTIONS: "--require /tmp/evil.js",
        OPENAI_API_KEY: "sk-ok",
      });
      const written = readFileSync(envPath, "utf8");
      expect(written).not.toContain("evil");
      expect(written).toContain("sk-ok");
      expect(result.written).toEqual(["OPENAI_API_KEY"]);
    });
  });

  describe("editing in place", () => {
    it("keeps comments and unrelated lines exactly as they were", () => {
      writeFileSync(
        envPath,
        "# my notes\nOPENAI_API_KEY=old\nSOMETHING_ELSE=keep me\n",
      );
      writeEnvFile(envPath, workspace, { OPENAI_API_KEY: "new" });
      const text = readFileSync(envPath, "utf8");
      expect(text).toContain("# my notes");
      expect(text).toContain("SOMETHING_ELSE=keep me");
      expect(text).toContain("OPENAI_API_KEY=new");
      expect(text).not.toContain("old");
    });

    it("removes a key when it is cleared", () => {
      writeFileSync(envPath, "OPENAI_API_KEY=old\nANTHROPIC_API_KEY=keep\n");
      writeEnvFile(envPath, workspace, { OPENAI_API_KEY: null });
      const text = readFileSync(envPath, "utf8");
      expect(text).not.toContain("OPENAI_API_KEY");
      expect(text).toContain("ANTHROPIC_API_KEY=keep");
    });

    it("does not mistake a commented-out line for the real one", () => {
      writeFileSync(envPath, "# OPENAI_API_KEY=commented\n");
      writeEnvFile(envPath, workspace, { OPENAI_API_KEY: "real" });
      const text = readFileSync(envPath, "utf8");
      expect(text).toContain("# OPENAI_API_KEY=commented");
      expect(text).toContain("OPENAI_API_KEY=real");
    });

    it("quotes a value that would not survive otherwise", () => {
      writeEnvFile(envPath, workspace, { KOS_SECRET_DISCORD: "has spaces #and hash" });
      expect(parseEnvFile(readFileSync(envPath, "utf8")).KOS_SECRET_DISCORD).toBe(
        "has spaces #and hash",
      );
    });
  });

  describe("permissions", () => {
    it("writes the file readable only by its owner", () => {
      writeEnvFile(envPath, workspace, { OPENAI_API_KEY: "sk-x" });
      expect(statSync(envPath).mode & 0o777).toBe(0o600);
    });

    /*
     * writeFileSync only applies its mode when it creates the file, so an
     * existing world-readable .env would have stayed that way.
     */
    it("tightens a file that was already too open", () => {
      writeFileSync(envPath, "OPENAI_API_KEY=old\n");
      chmodSync(envPath, 0o644);
      writeEnvFile(envPath, workspace, { OPENAI_API_KEY: "new" });
      expect(statSync(envPath).mode & 0o777).toBe(0o600);
    });
  });

  describe("showing a key without giving it away", () => {
    it("shows enough to tell two apart and no more", () => {
      expect(maskSecret("sk-proj-abcdef1234")).toBe("••••1234");
      expect(maskSecret("sk-proj-abcdef1234")).not.toContain("abcdef");
      expect(maskSecret(undefined)).toBeNull();
      expect(maskSecret("")).toBeNull();
      // A short value gives nothing away at all rather than most of itself.
      expect(maskSecret("abc")).toBe("••••");
    });
  });
});
