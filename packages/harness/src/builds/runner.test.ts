import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { credentials, prepareScope } from "./runner.js";

/**
 * Setting a build up. The parts worth testing here are the ones that decide
 * where it can act and what it is handed, both of which are settled before the
 * sub-agent runs a single tool.
 */
describe("preparing a build", () => {
  let root: string;
  let ws: Workspace;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-runner-"));
    ws = Workspace.open(root);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  describe("the folder it runs in", () => {
    it("creates the folder and returns a real path", () => {
      const dir = prepareScope(ws, "sites/tracker");
      expect(dir).toBe(realpathSync(join(ws.root, "sites", "tracker")));
    });

    /*
     * The scope directory becomes the jail root for every path the sub-agent
     * names. Pointing it at the workspace root would make that check vacuous
     * and hand a coding agent the database.
     */
    it("refuses to scope a build to the whole workspace", () => {
      for (const dir of ["", ".", "./", "sites/.."]) {
        expect(() => prepareScope(ws, dir), `${dir} was accepted`).toThrow();
      }
    });

    it("refuses a folder outside the workspace", () => {
      expect(() => prepareScope(ws, "../escape")).toThrow();
      // Refused outright, not reread as a workspace-relative path.
      expect(() => prepareScope(ws, "/etc/kos")).toThrow(/not absolute/);
      expect(() => prepareScope(ws, "/")).toThrow(/not absolute/);
    });

    it("refuses a folder reached through a symlink", () => {
      const outside = mkdtempSync(join(tmpdir(), "kos-out-"));
      mkdirSync(join(ws.root, "sites"), { recursive: true });
      symlinkSync(outside, join(ws.root, "sites", "away"));
      expect(() => prepareScope(ws, "sites/away")).toThrow();
      rmSync(outside, { recursive: true, force: true });
    });
  });

  describe("what it is given to sign in with", () => {
    it("passes an api key and keeps home inside the build", () => {
      const auth = credentials("/scope", { ANTHROPIC_API_KEY: "sk-x", HOME: "/Users/me" });
      expect(auth.env).toEqual({ ANTHROPIC_API_KEY: "sk-x" });
      expect(auth.home).toBe("/scope");
    });

    /*
     * Falling back to the owner's signed-in Claude Code needs their real home
     * to find its credentials. That widens where the sub-agent's config lives,
     * not what it may open: every read still goes through the scope check.
     */
    it("falls back to the owner's own sign-in when there is no key", () => {
      const auth = credentials("/scope", { HOME: "/Users/me", USER: "me" });
      expect(auth.home).toBe("/Users/me");
      // The account name, because the credential store is keyed by it:
      // without it Claude Code reports being logged out with the credentials
      // sitting right there. Verified against the real CLI.
      expect(auth.env).toEqual({ USER: "me" });
    });

    it("never passes anything else from the owner's shell", () => {
      const auth = credentials("/scope", {
        ANTHROPIC_API_KEY: "sk-x",
        OPENAI_API_KEY: "sk-openai",
        KOS_SECRET_DISCORD: "token",
        AWS_SECRET_ACCESS_KEY: "aws",
      });
      expect(Object.keys(auth.env)).toEqual(["ANTHROPIC_API_KEY"]);

      const fallback = credentials("/scope", {
        HOME: "/Users/me",
        USER: "me",
        OPENAI_API_KEY: "sk-openai",
        KOS_SECRET_DISCORD: "token",
      });
      expect(Object.keys(fallback.env).sort()).toEqual(["USER"]);
    });

    it("says what is missing when there is no way to sign in", () => {
      expect(() => credentials("/scope", {})).toThrow(/ANTHROPIC_API_KEY|signed-in/);
    });
  });
});
