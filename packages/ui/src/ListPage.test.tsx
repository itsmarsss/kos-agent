// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ListPage } from "./ListPage.js";

afterEach(cleanup);

describe("ListPage rows", () => {
  it("opens a row from the keys, as History's and Schedule's rows open", () => {
    const open = vi.fn();
    render(
      <ListPage
        title="Runs"
        rows={[{ id: 1, name: "Backup" }, { id: 2, name: "Faces" }]}
        rowKey={(r) => r.id}
        onRowClick={open}
        groupBy={() => "Today"}
        columns={[{ key: "name", header: "Name", searchText: (r) => r.name, render: (r) => r.name }]}
      />,
    );
    const backup = screen.getByText("Backup").closest("tr")!;
    expect(backup.tabIndex).toBe(0);
    backup.focus();
    fireEvent.keyDown(backup, { key: "ArrowDown" });
    const faces = screen.getByText("Faces").closest("tr")!;
    expect(document.activeElement).toBe(faces);
    fireEvent.keyDown(faces, { key: "Enter" });
    expect(open).toHaveBeenCalledWith({ id: 2, name: "Faces" });
  });

  it("is one Tab stop, the row the keys were last on, each row named and each column", () => {
    render(
      <ListPage
        title="Runs"
        rows={[{ id: 1, name: "Backup", ok: true }, { id: 2, name: "Faces", ok: false }]}
        rowKey={(r) => r.id}
        onRowClick={() => undefined}
        rowLabel={(r) => `${r.name}, ${r.ok ? "Done" : "Failed"}`}
        columns={[
          { key: "mark", header: "", srHeader: "Kind", render: () => "" },
          { key: "name", header: "Name", searchText: (r) => r.name, render: (r) => r.name },
        ]}
      />,
    );
    const backup = screen.getByRole("row", { name: "Backup, Done" });
    const faces = screen.getByRole("row", { name: "Faces, Failed" });
    expect([backup.tabIndex, faces.tabIndex]).toEqual([0, -1]);
    backup.focus();
    fireEvent.keyDown(backup, { key: "ArrowDown" });
    expect(document.activeElement).toBe(faces);
    expect([backup.tabIndex, faces.tabIndex]).toEqual([-1, 0]);
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Kind", "Name"]);
  });
});
