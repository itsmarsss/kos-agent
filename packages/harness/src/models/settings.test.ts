import { describe, expect, it } from "vitest";

import { SecretsRegistry } from "../secrets/secrets.js";
import { createDefaultRouter } from "./router.js";
import { applyModelSettings, parseModelSettings } from "./settings.js";

function router() {
  const secrets = new SecretsRegistry();
  secrets.set("openai", "sk-test");
  return createDefaultRouter(secrets);
}

describe("parseModelSettings", () => {
  it("keeps the fields it understands", () => {
    expect(
      parseModelSettings({
        reasoning: { model: "gpt-5.5", effort: "high", maxTokens: 8000 },
      }),
    ).toEqual({ reasoning: { model: "gpt-5.5", effort: "high", maxTokens: 8000 } });
  });

  it("drops an effort that is not one of ours", () => {
    expect(parseModelSettings({ reasoning: { effort: "ludicrous" } })).toEqual({});
  });

  it("drops a non-positive or fractional token limit", () => {
    expect(parseModelSettings({ reasoning: { maxTokens: 0 } })).toEqual({});
    expect(parseModelSettings({ reasoning: { maxTokens: 1.5 } })).toEqual({});
  });

  it("ignores task names it does not dispatch on", () => {
    expect(parseModelSettings({ nonsense: { model: "x" } })).toEqual({});
  });

  it("survives junk", () => {
    expect(parseModelSettings(null)).toEqual({});
    expect(parseModelSettings("nope")).toEqual({});
  });
});

describe("applyModelSettings", () => {
  it("repoints a task without touching its provider", () => {
    const r = router();
    applyModelSettings(r, { reasoning: { model: "gpt-5.5" } });
    expect(r.routeFor("reasoning")).toMatchObject({
      provider: "openai",
      spec: { model: "gpt-5.5" },
    });
  });

  it("leaves fields the owner did not set", () => {
    // Clearing one field must not silently clear the rest of the spec.
    const r = router();
    const before = r.routeFor("reasoning").spec.effort;
    applyModelSettings(r, { reasoning: { model: "gpt-5.5" } });
    expect(r.routeFor("reasoning").spec.effort).toBe(before);
  });

  it("does nothing when there is nothing saved", () => {
    const r = router();
    const before = r.routeFor("reasoning");
    applyModelSettings(r, undefined);
    expect(r.routeFor("reasoning")).toEqual(before);
  });
});
