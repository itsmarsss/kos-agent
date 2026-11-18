import { describe, expect, it } from "vitest";

import { afterRestart, endedWords, helloSession, readHeld } from "./held.js";

describe("the session kept beside the worker's memory", () => {
  it("reads only what it kept", () => {
    expect(readHeld({ id: "ses_1", kos: "dev_a", tabs: [3, "x", 4.5, 7] })).toEqual({ id: "ses_1", kos: "dev_a", tabs: [3, 7] });
    expect(readHeld({ id: "ses_1", kos: "dev_a", tabs: [], ended: "idle" })).toEqual({ id: "ses_1", kos: "dev_a", tabs: [], ended: "idle" });
    expect(readHeld({ id: "ses_1", kos: "dev_a", ended: "nonsense" })).toEqual({ id: "ses_1", kos: "dev_a", tabs: [] });
    for (const v of [undefined, null, "ses_1", { kos: "dev_a" }, { id: "", kos: "dev_a" }, { id: "ses_1" }]) expect(readHeld(v)).toBeUndefined();
  });

  it("is over once a worker starts again, for a session that was live; one that ended keeps its reason", () => {
    expect(afterRestart({ id: "ses_1", kos: "dev_a", tabs: [3] })).toEqual({ id: "ses_1", kos: "dev_a", tabs: [3], ended: "restarted" });
    const ended = { id: "ses_1", kos: "dev_a", tabs: [], ended: "idle" as const };
    expect(afterRestart(ended)).toBe(ended);
    expect(afterRestart(undefined)).toBeUndefined();
  });

  it("is said in the hello to its own KOS alone: live, or ended and why", () => {
    expect(helloSession({ id: "ses_1", kos: "dev_a", tabs: [3] }, "dev_a")).toEqual({ id: "ses_1" });
    expect(helloSession({ id: "ses_1", kos: "dev_a", tabs: [], ended: "restarted" }, "dev_a")).toEqual({ id: "ses_1", ended: "restarted" });
    expect(helloSession({ id: "ses_1", kos: "dev_a", tabs: [] }, "dev_b")).toBeUndefined();
    expect(helloSession(undefined, "dev_a")).toBeUndefined();
  });

  it("says each reason in words the panel shows", () => {
    expect(endedWords("restarted")).toMatch(/restarted/);
    expect(endedWords("detached")).toMatch(/debugging bar/);
    expect(endedWords("host")).toMatch(/line to KOS dropped/);
  });
});
