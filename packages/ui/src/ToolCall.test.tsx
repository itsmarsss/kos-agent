// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ToolCall } from "./ToolCall.js";

afterEach(cleanup);

describe("a tool call's summary", () => {
  it("opens the file a step names on its own click, without toggling the card", () => {
    window.location.hash = "";
    const { container } = render(<ToolCall event={{ kind: "tool", name: "files.read", summary: "Read blobs/verity/blob.md.", args: {}, result: "ok" }} />);
    const link = screen.getByRole("link", { name: "blobs/verity/blob.md" });
    fireEvent.click(link);
    expect(window.location.hash).toBe("#/files/blobs%2Fverity%2Fblob.md");
    expect(container.querySelector(".toolcall-head")?.getAttribute("aria-expanded")).toBe("false");
    // Plain words stay plain.
    expect(screen.getByText(/Read/)).toBeTruthy();
  });
});
