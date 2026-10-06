// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api, type ReviewItem } from "./api.js";
import { MemoryDecision } from "./MemoryPage.js";

/**
 * A decision shows what each claim says, not only what it is called, and
 * Keep sits on the row it keeps.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function item(over: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: 7,
    kind: "contradiction",
    keys: ["global/city", "project:trip/city"],
    note: "Two cities.",
    createdAt: 1,
    resolvedAt: null,
    resolution: null,
    claims: [
      { qualified: "global/city", scope: "global", key: "city", value: "Montreal", kind: "fact", trust: "owner", useCount: 4, lastUsedAt: Date.now() - 60_000, createdAt: Date.now() - 86_400_000 },
      { qualified: "project:trip/city", scope: "project:trip", key: "city", value: "Lisbon", kind: "fact", trust: "agent", useCount: 0, lastUsedAt: null, createdAt: Date.now() - 3_600_000 },
    ],
    ...over,
  };
}

describe("a memory decision", () => {
  it("shows each claim's value and use, and keeps the one whose button is pressed", async () => {
    const resolve = vi.spyOn(api, "resolveMemoryReview").mockResolvedValue({ item: item(), archived: [], promoted: [] });
    const onResolved = vi.fn();
    render(<MemoryDecision item={item()} onResolved={onResolved} />);
    expect(screen.getByText("These claims disagree")).toBeTruthy();
    expect(screen.getByText("Montreal")).toBeTruthy();
    expect(screen.getByText("Lisbon")).toBeTruthy();
    expect(screen.getByText(/used 4×, last 1m ago/)).toBeTruthy();
    expect(screen.getByText(/from an agent · never used/)).toBeTruthy();

    const keeps = screen.getAllByText("Keep this");
    expect(keeps).toHaveLength(2);
    fireEvent.click(keeps[1]!);
    await waitFor(() => expect(onResolved).toHaveBeenCalled());
    expect(resolve).toHaveBeenCalledWith(7, "keep", "project:trip/city");
  });

  it("offers to leave every claim, and says when one is already gone", () => {
    render(
      <MemoryDecision
        item={item({ keys: ["global/a", "global/b", "global/c"], claims: [{ qualified: "global/a", scope: "global", key: "a", value: "x" }, { qualified: "global/b", scope: "global", key: "b" }, { qualified: "global/c", scope: "global", key: "c", value: "z" }] })}
        onResolved={() => {}}
      />,
    );
    expect(screen.getByText("No longer in memory.")).toBeTruthy();
    expect(screen.getAllByText("Keep this")).toHaveLength(2);
    expect(screen.getByText("All are right, leave them")).toBeTruthy();
  });

  it("asks the promotion question with yes and no", () => {
    const resolve = vi.spyOn(api, "resolveMemoryReview").mockResolvedValue({ item: item(), archived: [], promoted: [] });
    render(<MemoryDecision item={item({ kind: "promotion", keys: ["project:site/editor"], claims: [{ qualified: "project:site/editor", scope: "project:site", key: "editor", value: "neovim" }] })} onResolved={() => {}} />);
    expect(screen.queryByText("Keep this")).toBeNull();
    fireEvent.click(screen.getByText("Yes, make it global"));
    expect(resolve).toHaveBeenCalledWith(7, "promote", undefined);
  });

  it("still shows the keys when the claims were not looked up", () => {
    render(<MemoryDecision item={item({ claims: undefined })} onResolved={() => {}} />);
    expect(screen.getAllByText("city")).toHaveLength(2);
    expect(screen.getAllByText("No longer in memory.")).toHaveLength(2);
  });
});
