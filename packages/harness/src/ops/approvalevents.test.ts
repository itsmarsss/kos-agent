import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Workspace } from "../store/workspace.js";
import { ApprovalQueue } from "./approvals.js";

/**
 * Being told when an action is decided.
 *
 * A build blocked on a permission prompt polled the row every 500ms: a busy
 * loop that also kept the owner waiting up to half a second after they had
 * already answered.
 */
describe("approval decisions as events", () => {
  let root: string;
  let ws: Workspace;
  let queue: ApprovalQueue;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-appr-ev-"));
    ws = Workspace.open(root);
    queue = new ApprovalQueue(ws.db);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  const queued = (): number =>
    queue.enqueue({ tool: "build.Bash", args: {}, riskTier: "risky" }).id;

  it("tells a listener the moment something is approved", () => {
    const heard: string[] = [];
    queue.onDecided((a) => heard.push(`${a.id}:${a.status}`));
    const id = queued();
    queue.approve(id, "owner");
    expect(heard).toEqual([`${id}:approved`]);
  });

  it("tells them about a denial too", () => {
    const heard: string[] = [];
    queue.onDecided((a) => heard.push(a.status));
    queue.deny(queued(), "owner");
    expect(heard).toEqual(["denied"]);
  });

  it("says nothing for an action that was already decided", () => {
    const id = queued();
    queue.approve(id, "owner");
    const heard = vi.fn();
    queue.onDecided(heard);
    // Deciding it twice is a no-op, so there is nothing to announce and a
    // waiter must not be woken by it.
    queue.approve(id, "owner");
    expect(heard).not.toHaveBeenCalled();
  });

  it("stops telling a listener that has unsubscribed", () => {
    const heard = vi.fn();
    const off = queue.onDecided(heard);
    off();
    queue.approve(queued(), "owner");
    expect(heard).not.toHaveBeenCalled();
  });

  /*
   * One waiter throwing must not stop the others hearing: they are separate
   * builds, and one broken listener should not leave another blocked forever.
   */
  it("keeps telling the others when one listener throws", () => {
    const good = vi.fn();
    queue.onDecided(() => {
      throw new Error("bad waiter");
    });
    queue.onDecided(good);
    queue.approve(queued(), "owner");
    expect(good).toHaveBeenCalled();
  });
});
