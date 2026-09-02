import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { PressRoutes } from "./presses.js";

describe("PressRoutes", () => {
  let root: string;
  let ws: Workspace;
  let routes: PressRoutes;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-press-"));
    ws = Workspace.open(root);
    routes = new PressRoutes(ws.db);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("finds where a press belongs", () => {
    const token = routes.register({
      conversationId: "c1",
      buttonId: "ship",
      label: "Ship it",
    });
    expect(routes.get(token)).toMatchObject({
      conversationId: "c1",
      buttonId: "ship",
      label: "Ship it",
    });
  });

  it("does not put the conversation id on the wire", () => {
    // The custom id is readable by anyone who can see the message, so the
    // token has to be a name rather than the thing it names.
    const token = routes.register({
      conversationId: "primary:owner",
      buttonId: "yes",
      label: "Yes",
    });
    expect(token).not.toContain("primary");
    expect(token).not.toContain("owner");
  });

  it("gives each button its own token", () => {
    const a = routes.register({ conversationId: "c", buttonId: "a", label: "A" });
    const b = routes.register({ conversationId: "c", buttonId: "b", label: "B" });
    expect(a).not.toBe(b);
  });

  it("knows nothing about a token it never gave out", () => {
    expect(routes.get("made-up")).toBeUndefined();
  });

  it("sweeps routes old enough that the message is gone", () => {
    const token = routes.register({ conversationId: "c", buttonId: "x", label: "X" });
    expect(routes.prune(60_000)).toBe(0);
    expect(routes.prune(-1)).toBe(1);
    expect(routes.get(token)).toBeUndefined();
  });
});
