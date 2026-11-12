// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api, type PageSummary } from "../api.js";
import { MentionPicker } from "./MentionPicker.js";

const row = (id: string, title: string): PageSummary => ({ id, projectSlug: "p", title, path: "x", updatedAt: 1, kind: "html", artifactKind: "doc" });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the mention picker", () => {
  it("keeps Tab inside it, and closes when focus goes elsewhere", async () => {
    vi.spyOn(api, "pages").mockResolvedValue([row("a", "Alpha"), row("b", "Beta")]);
    const onClose = vi.fn();
    render(
      <>
        <button type="button">outside</button>
        <MentionPicker at={{ x: 10, y: 10 }} exclude="self" onPick={vi.fn()} onClose={onClose} />
      </>,
    );
    const field = screen.getByRole("combobox");
    await waitFor(() => screen.getByRole("option", { name: /Alpha/ }));
    field.focus();
    fireEvent.keyDown(field, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("option", { name: /Alpha/ }));
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(document.activeElement).toBe(field);
    fireEvent.keyDown(field, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole("option", { name: /Beta/ }));
    expect(onClose).not.toHaveBeenCalled();
    act(() => screen.getByRole("button", { name: "outside" }).focus());
    expect(onClose).toHaveBeenCalledWith(false);
  });
});
