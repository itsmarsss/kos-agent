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
});
