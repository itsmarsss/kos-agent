import { describe, expect, it } from "vitest";

import type { ModelMessage } from "../models/types.js";
import { keepRecentPictures, withoutPictures } from "./pictures.js";

const shot = (id: string): ModelMessage => ({
  role: "user",
  content: [{ type: "tool_result", toolUseId: id, content: `screen ${id}`, images: [{ mediaType: "image/jpeg", data: id }] }],
});
const said = (text: string): ModelMessage => ({ role: "assistant", content: [{ type: "text", text }] });

const pictures = (messages: ModelMessage[]): string[] =>
  messages.flatMap((m) => m.content.flatMap((b) => (b.type === "tool_result" ? (b.images ?? []).map((i) => i.data) : [])));

describe("pictures sent to the model", () => {
  it("keeps the latest few and names the rest as dropped", () => {
    const history = [shot("a"), said("next"), shot("b"), said("next"), shot("c"), said("next"), shot("d")];
    const sent = keepRecentPictures(history, 3);
    expect(pictures(sent)).toEqual(["b", "c", "d"]);
    const first = sent[0]!.content[0]!;
    expect(first.type === "tool_result" && first.content).toContain("dropped to save room");
  });

  it("leaves the history it was given as it was", () => {
    const history = [shot("a"), shot("b")];
    keepRecentPictures(history, 1);
    expect(pictures(history)).toEqual(["a", "b"]);
  });

  it("stores none, keeping the words", () => {
    const stored = withoutPictures([said("look"), shot("a")]);
    expect(pictures(stored)).toEqual([]);
    const block = stored[1]!.content[0]!;
    expect(block.type === "tool_result" && block.content.startsWith("screen a")).toBe(true);
  });
});
