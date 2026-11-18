// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useAttachments } from "./Attachments.js";
import { backInComposer } from "./composer.js";

describe("a send that failed", () => {
  const photo = { name: "cart.png", mediaType: "image/png", data: "iVBORw0KGgo=" };

  it("puts the words back in the composer, unless something new was typed since", () => {
    expect(backInComposer("", "skip the ebooks")).toBe("skip the ebooks");
    expect(backInComposer("  ", "skip the ebooks")).toBe("skip the ebooks");
    expect(backInComposer("and the red one", "skip the ebooks")).toBe("and the red one");
  });

  it("puts its files back, unless new ones were attached since", () => {
    const { result } = renderHook(() => useAttachments());
    act(() => result.current.restore([photo]));
    expect(result.current.files).toEqual([photo]);
    act(() => result.current.restore([{ ...photo, name: "other.png" }]));
    expect(result.current.files).toEqual([photo]);
  });
});
