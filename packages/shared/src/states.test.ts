import { describe, expect, it } from "vitest";

import { isState, STATE_WORDS, stateOfRun } from "./states.js";
import { KIND_WORDS, kindWord, providerWord, slugWords, SYSTEM_SCHEDULES } from "./words.js";

describe("the state words", () => {
  it("say each state in one sentence-case word or two, in a tone that means it", () => {
    for (const [state, { word, tone }] of Object.entries(STATE_WORDS)) {
      expect(word[0], state).toBe(word[0]!.toUpperCase());
      expect(word.split(" ").length, state).toBeLessThanOrEqual(2);
      expect(["ok", "warn", "danger", "accent", "muted"]).toContain(tone);
    }
  });

  it("never colour quiet or off as success", () => {
    for (const state of ["idle", "off", "skipped", "dormant", "archived"] as const) expect(STATE_WORDS[state].tone).toBe("muted");
    expect(STATE_WORDS.failed.tone).toBe("danger");
  });

  it("read a run's stored status as its state", () => {
    expect(["ok", "partial", "error", "failed", "running", "skipped", "pending", "what"].map(stateOfRun)).toEqual(["ok", "partial", "failed", "failed", "running", "skipped", "waiting", "skipped"]);
  });

  it("know a state from anything else", () => {
    expect(["on", "failed", "toString", "", 1].map(isState)).toEqual([true, true, false, false, false]);
  });
});

describe("the kind words", () => {
  it("are in sentence case, and call a cron or a job a schedule", () => {
    for (const [kind, word] of Object.entries(KIND_WORDS)) expect(word[0], kind).toBe(word[0]!.toUpperCase());
    expect([kindWord("job"), kindWord("cron"), kindWord("project"), kindWord("API_KEY"), kindWord("assistant")]).toEqual(["Schedule", "Schedule", "Project", "API key", "KOS"]);
    expect(kindWord("weekly-report")).toBe("Weekly report");
  });

  it("give each memory schedule one name, and say a slug as words", () => {
    expect([SYSTEM_SCHEDULES["kos.memory"], SYSTEM_SCHEDULES["kos.dream"], SYSTEM_SCHEDULES["kos.observe"]]).toEqual(["Memory: Read", "Memory: Tidy", "Memory: Condense"]);
    expect(slugWords("plant-watcher")).toBe("Plant watcher");
    expect(slugWords("recap")).toBe("Recap");
  });
});

describe("a provider's word", () => {
  it("calls custom the owner's own server, and known ones by their names", () => {
    expect(["custom", "anthropic", "openai", "groq"].map(providerWord)).toEqual(["Your own server", "Anthropic", "OpenAI", "groq"]);
  });
});
