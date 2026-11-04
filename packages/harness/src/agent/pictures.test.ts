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
  it("keeps the latest few and names the rest as dropped, a batch at a time", () => {
    const steps = (n: number): ModelMessage[] => [..."abcdefgh"].slice(0, n).flatMap((id) => [shot(id), said("next")]);
    // Up to keep + batch - 1 stay, so the front of what is sent holds still for a few steps.
    expect(pictures(keepRecentPictures(steps(4), 3, 3))).toEqual(["a", "b", "c", "d"]);
    expect(pictures(keepRecentPictures(steps(5), 3, 3))).toEqual(["a", "b", "c", "d", "e"]);
    const sent = keepRecentPictures(steps(6), 3, 3);
    expect(pictures(sent)).toEqual(["d", "e", "f"]);
    const first = sent[0]!.content[0]!;
    expect(first.type === "tool_result" && first.content).toContain("dropped to save room");
    // One at a time drops on every step, as before.
    expect(pictures(keepRecentPictures(steps(4), 3, 1))).toEqual(["b", "c", "d"]);
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
