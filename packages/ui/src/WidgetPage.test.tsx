// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api, type PagePayload } from "./api.js";
import { WidgetPage } from "./WidgetPage.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const page = (trashedAt?: number): PagePayload => ({
  record: { id: "tasks", projectSlug: "tasks", title: "Tasks", path: "x", updatedAt: 1, kind: "spec", artifactKind: "page", ...(trashedAt ? { trashedAt } : {}) },
  kind: "spec",
  spec: { id: "tasks", title: "Tasks", widgets: [{ type: "form", title: "Add", mutate: { table: "tasks", columns: ["title"], allow: ["insert"] } }] },
  data: {},
});

const open = (payload: PagePayload, onReload = vi.fn().mockResolvedValue(undefined)): void =>
  void render(<WidgetPage page={payload} projects={[]} onReload={onReload} onGone={() => undefined} onError={() => undefined} />);

describe("a widget page", () => {
  it("writes through its form while it is out of the trash", async () => {
    vi.spyOn(api, "pageHistory").mockResolvedValue([]);
    const mutate = vi.spyOn(api, "mutate").mockResolvedValue({ changes: 1 } as never);
    vi.spyOn(api, "page").mockResolvedValue(page());
    open(page());
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "write tests" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mutate).toHaveBeenCalledWith({ pageId: "tasks", widgetIndex: 0, op: "insert", values: { title: "write tests" } }));
  });

  it("in the trash says so, offers Restore, and its form writes nothing", async () => {
    const history = vi.spyOn(api, "pageHistory").mockResolvedValue([]);
    const mutate = vi.spyOn(api, "mutate");
    const restore = vi.spyOn(api, "restoreArtifact").mockResolvedValue(page().record);
    const reload = vi.fn().mockResolvedValue(undefined);
    open(page(Date.now() - 60_000), reload);
    expect(screen.getByRole("status").textContent).toMatch(/in the trash/);
    expect(screen.getByLabelText("Title").closest(".kos-page")?.hasAttribute("inert")).toBe(true);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "from the trash" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("no write path available")).toBeTruthy();
    expect(mutate).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith("tasks"));
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });
});
