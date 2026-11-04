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

  it("keeps the screen work's model, which the owner may point back at the turn's", () => {
    expect(parseModelSettings({ screen: { model: "claude-opus-4-8" } })).toEqual({ screen: { model: "claude-opus-4-8" } });
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
  it("keeps screen work on the reasoning model until the owner names one, and puts it back when they clear it", () => {
    const r = router();
    applyModelSettings(r, { reasoning: { model: "gpt-5.5" } });
    expect(r.routeFor("screen")).toEqual(r.routeFor("reasoning"));
    // A later change of the reasoning model carries screen work with it: no split nobody chose.
    applyModelSettings(r, { reasoning: { model: "gpt-5.6-terra" } });
    expect(r.routeFor("screen").spec.model).toBe("gpt-5.6-terra");
    applyModelSettings(r, { reasoning: { model: "gpt-5.6-terra" }, screen: { model: "gpt-5.4-mini", effort: "low" } });
    expect(r.routeFor("screen").spec).toMatchObject({ model: "gpt-5.4-mini", effort: "low" });
    expect(r.routeFor("reasoning").spec.model).toBe("gpt-5.6-terra");
    applyModelSettings(r, { reasoning: { model: "gpt-5.6-terra" }, screen: { effort: "low" } });
    expect(r.routeFor("screen")).toEqual(r.routeFor("reasoning"));
  });

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

describe("the owner's own endpoint", () => {
  it("reads a base url from settings, else the environment, and refuses junk", async () => {
    const { parseCustomEndpoint } = await import("./settings.js");
    expect(parseCustomEndpoint({ baseUrl: "http://127.0.0.1:11434/v1/" }, {})).toEqual({ baseUrl: "http://127.0.0.1:11434/v1" });
    expect(parseCustomEndpoint(undefined, { KOS_CUSTOM_BASE_URL: "https://gw.example/v1" })).toEqual({ baseUrl: "https://gw.example/v1" });
    expect(parseCustomEndpoint({ baseUrl: "not a url" }, {})).toBeUndefined();
    expect(parseCustomEndpoint({}, {})).toBeUndefined();
  });

  it("reads a classifier endpoint from settings or the environment", async () => {
    const { parseClassifierEndpoint } = await import("./settings.js");
    expect(parseClassifierEndpoint({ url: "https://jev.example/classify" }, {})).toEqual({ url: "https://jev.example/classify" });
    expect(parseClassifierEndpoint(undefined, { KOS_CLASSIFIER_URL: "http://127.0.0.1:9000/c" })).toEqual({ url: "http://127.0.0.1:9000/c" });
    expect(parseClassifierEndpoint({ url: "nope" }, {})).toBeUndefined();
  });

  it("lets a setting move a task to another provider", async () => {
    const { parseModelSettings } = await import("./settings.js");
    expect(parseModelSettings({ cheap: { provider: "custom", model: "local-7b" } })).toEqual({ cheap: { provider: "custom", model: "local-7b" } });
  });
});
