import { describe, expect, it, vi } from "vitest";

import type { Inference } from "../agent/loop.js";
import type { ModelResponse } from "../models/types.js";
import { LlmSalienceConfirmer, parseConfirmerReply } from "./confirmer.js";
import { MemoryWriter } from "./writer.js";
import { FactsStore } from "./facts.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../store/workspace.js";

function reply(text: string): ModelResponse {
  return {
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage: { inputTokens: 0, outputTokens: 0 },
    model: "stub",
  };
}

function stubInference(text: string): Inference {
  return { generate: vi.fn(async () => reply(text)) };
}

describe("parseConfirmerReply", () => {
  it("parses a well-formed reply", () => {
    const facts = parseConfirmerReply(
      '{"facts":[{"key":"timezone","value":"America/New_York","kind":"fact"}]}',
    );
    expect(facts).toEqual([
      { key: "timezone", value: "America/New_York", kind: "fact" },
    ]);
  });

  it("tolerates prose or a code fence around the JSON", () => {
    const facts = parseConfirmerReply(
      'Sure!\n```json\n{"facts":[{"key":"employer","value":"Acme","kind":"fact"}]}\n```',
    );
    expect(facts).toHaveLength(1);
    expect(facts[0]?.key).toBe("employer");
  });

  it("normalizes keys to snake_case", () => {
    const facts = parseConfirmerReply(
      '{"facts":[{"key":"Coffee Order!","value":"oat flat white","kind":"preference"}]}',
    );
    expect(facts[0]?.key).toBe("coffee_order");
    expect(facts[0]?.kind).toBe("preference");
  });

  it("returns nothing for malformed output rather than throwing", () => {
    expect(parseConfirmerReply("not json at all")).toEqual([]);
    expect(parseConfirmerReply("")).toEqual([]);
    expect(parseConfirmerReply('{"facts":"nope"}')).toEqual([]);
  });

  it("drops entries missing a usable key or value", () => {
    const facts = parseConfirmerReply(
      '{"facts":[{"key":"","value":"x"},{"key":"ok","value":""},{"key":"good","value":"kept"}]}',
    );
    expect(facts).toEqual([{ key: "good", value: "kept", kind: "fact" }]);
  });

  it("defaults an unrecognized kind to fact", () => {
    const facts = parseConfirmerReply(
      '{"facts":[{"key":"k","value":"v","kind":"nonsense"}]}',
    );
    expect(facts[0]?.kind).toBe("fact");
  });
});

describe("LlmSalienceConfirmer", () => {
  it("routes to the cheap task class", async () => {
    const inference = stubInference('{"facts":[]}');
    await new LlmSalienceConfirmer(inference).confirm("I always use pnpm", []);
    expect(inference.generate).toHaveBeenCalledWith(
      "cheap",
      expect.objectContaining({ system: expect.any(String) }),
    );
  });

  it("persists confirmed facts through the writer on a maybe verdict", async () => {
    const root = mkdtempSync(join(tmpdir(), "kos-confirm-"));
    const ws = Workspace.open(root);
    try {
      const facts = new FactsStore(ws.db);
      const writer = new MemoryWriter(
        facts,
        new LlmSalienceConfirmer(
          stubInference(
            '{"facts":[{"key":"employer","value":"a robotics startup downtown","kind":"fact"}]}',
          ),
        ),
      );
      // First-person with no heuristic candidate is a "maybe" verdict, which
      // was silently dropped because no confirmer was ever wired.
      const written = await writer.ingest(
        "u1",
        "I work at a robotics startup downtown",
        "chat",
      );
      expect(written).toHaveLength(1);
      expect(facts.get("u1", "employer")?.value).toBe(
        "a robotics startup downtown",
      );
    } finally {
      ws.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
