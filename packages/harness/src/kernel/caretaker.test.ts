import { describe, expect, it } from "vitest";

import type { ModelMessage } from "../models/types.js";
import { Caretaker, isTransient, type CaretakerDeps } from "./caretaker.js";

function deps(over: Partial<CaretakerDeps> = {}) {
  const log: string[] = [];
  const sessions = new Map<string, ModelMessage[]>();
  let n = 0;
  const base: CaretakerDeps = {
    ownerId: "owner",
    isClosed: () => false,
    isHalted: () => false,
    behaviour: () => ({ autoFix: true, fixSteps: 24 }),
    health: { observe: (_k, _l, ok, error) => (ok ? undefined : { kind: "failing", streak: 1, text: `failing: ${error}` } as never) },
    notify: async (p) => { log.push(`notify:${p.text}`); },
    sessions: { get: (id) => sessions.get(id) ?? [], record: (id, m) => { sessions.set(id, m); } },
    conversations: { create: ({ title }) => { n += 1; log.push(`create:${title}`); return { id: `c${n}` }; }, touch: (id) => { log.push(`touch:${id}`); } },
    crons: { list: () => [{ id: 7, name: "Nightly" }], get: (id) => (id === 7 ? { id: 7, name: "Nightly" } : undefined) },
    manifest: { list: () => [{ slug: "books" }, { slug: "book" }] },
    handleMessage: async (text, opts) => { log.push(`turn:${opts.sessionId}:${opts.maxIterations}:${text.includes("evidence") ? "prompt" : "?"}`); },
  };
  // The Map behind the sessions dep, exposed under its own name so it
  // cannot shadow the dep when the fixture is spread into the service.
  return { ...base, ...over, log, store: sessions };
}

describe("looking after failures", () => {
  it("tells the owner once and starts a fix on the first failure", async () => {
    const d = deps();
    new Caretaker(d).report("cron:7", "Nightly", false, "boom");
    await new Promise((r) => setTimeout(r, 0));
    expect(d.log).toEqual(["notify:failing: boom", "create:Fix: Nightly", "turn:c1:24:prompt"]);
  });

  it("does not try to fix when auto-fix is off, or KOS is halted, or it is not the first failure", async () => {
    for (const over of [
      { behaviour: () => ({ autoFix: false, fixSteps: 24 }) },
      { isHalted: () => true },
      { health: { observe: () => ({ kind: "failing", streak: 2, text: "still" } as never) } },
    ] as Partial<CaretakerDeps>[]) {
      const d = deps(over);
      new Caretaker(d).report("cron:7", "Nightly", false, "boom");
      await new Promise((r) => setTimeout(r, 0));
      expect(d.log.some((l) => l.startsWith("create:"))).toBe(false);
    }
  });

  it("tells the owner about a connection blip but opens no fix chat for it", async () => {
    for (const error of ["Connection error.", "fetch failed", "ECONNRESET", "429 rate limit exceeded", "Request timed out"]) {
      const d = deps();
      new Caretaker(d).report("cron:7", "Nightly", false, error);
      await new Promise((r) => setTimeout(r, 0));
      expect(d.log).toEqual([`notify:failing: ${error} That reads as a connection blip; the next run will tell.`]);
    }
    expect(isTransient("TypeError: x is not a function")).toBe(false);
    expect(isTransient("model down")).toBe(false);
    expect(isTransient(null)).toBe(false);
  });

  it("says when the fix turn itself could not reach the model", async () => {
    const d = deps({ handleMessage: async () => { throw new Error("Connection error."); } });
    const r = await new Caretaker(d).startFix({ label: "Nightly", error: "boom", what: "scheduled job" });
    await new Promise((res) => setTimeout(res, 0));
    expect(d.store.get(r.conversationId)?.at(-1)?.content[0]).toMatchObject({
      text: expect.stringMatching(/^I could not reach the model to look into this \(Connection error\.\)/),
    });
  });

  it("leaves a note in the primary chat when there is no surface, or the surface fails", async () => {
    const quiet = deps({ notify: undefined });
    new Caretaker(quiet).tell("hello");
    expect(quiet.store.get("primary:owner")?.[0]?.content[0]).toMatchObject({ type: "text", text: "hello" });
    const broken = deps({ notify: async () => { throw new Error("down"); } });
    new Caretaker(broken).tell("hello again");
    await new Promise((r) => setTimeout(r, 0));
    expect(broken.store.get("primary:owner")?.[0]?.content[0]).toMatchObject({ text: "hello again" });
  });

  it("points the fix at the job by name or id, else at the longest matching project", async () => {
    const c = new Caretaker(deps());
    const byName = await c.startFix({ label: "Nightly", error: "x", what: "scheduled job" });
    expect(byName.prompt).toContain("@schedule:Nightly");
    const byId = await c.startFix({ label: "something", error: "x", what: "scheduled job", ref: "cron #7" });
    expect(byId.prompt).toContain("@schedule:Nightly");
    const byProject = await c.startFix({ label: "page for books broke", error: "x", what: "run" });
    expect(byProject.prompt).toContain("@project:books");
    expect(byProject.title).toBe("Fix: page for books broke");
  });

  it("fences the error so a backtick inside it cannot break out", async () => {
    const r = await new Caretaker(deps()).startFix({ label: "l", error: "has ``` inside", what: "run" });
    expect(r.prompt).toContain("````\nhas ``` inside\n````");
  });

  it("records an apology in the fix chat when the turn fails, unless closing", async () => {
    const failing = deps({ handleMessage: async () => { throw new Error("model down"); } });
    const r = await new Caretaker(failing).startFix({ label: "l", error: "e", what: "run" });
    await new Promise((res) => setTimeout(res, 0));
    expect(failing.store.get(r.conversationId)?.at(-1)?.content[0]).toMatchObject({ text: "I could not finish looking into this: model down" });
    // With the question it was asked, so the chat says what it was for.
    expect(failing.store.get(r.conversationId)?.[0]).toMatchObject({ role: "user", content: [{ type: "text", text: expect.stringContaining("failed and I would like you to fix it") }] });
    const closing = deps({ handleMessage: async () => { throw new Error("x"); }, isClosed: () => true });
    const r2 = await new Caretaker(closing).startFix({ label: "l", error: "e", what: "run" });
    await new Promise((res) => setTimeout(res, 0));
    expect(closing.store.get(r2.conversationId)).toBeUndefined();
  });
});
