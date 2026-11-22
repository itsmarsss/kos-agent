// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { FieldError } from "./api.js";
import { NewProjectDialog } from "./NewProjectDialog.js";

beforeAll(() => {
  window.matchMedia ??= (() => ({ addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
});

afterEach(cleanup);

function show(onCreate = vi.fn().mockResolvedValue(undefined)): { onCreate: typeof onCreate; name: HTMLInputElement; create: HTMLButtonElement } {
  render(<NewProjectDialog open onClose={() => undefined} onCreate={onCreate} taken={["Home lab"]} />);
  return { onCreate, name: screen.getByPlaceholderText("Reading log") as HTMLInputElement, create: screen.getByRole("button", { name: "Create" }) as HTMLButtonElement };
}

describe("New project", () => {
  it("says a taken name on the field as it is typed, and holds Create", () => {
    const { name, create } = show();
    fireEvent.change(name, { target: { value: "home LAB" } });
    expect(screen.getByRole("alert").textContent).toBe("There is already a project called “Home lab”. Pick another name.");
    expect(create.disabled).toBe(true);
    fireEvent.change(name, { target: { value: "Garden" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(create.disabled).toBe(false);
  });

  it("says a name too long with the limit, and says nothing of a fresh empty form", () => {
    const { name, create } = show();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(create.disabled).toBe(true);
    fireEvent.change(name, { target: { value: "a".repeat(81) } });
    expect(screen.getByRole("alert").textContent).toBe("Keep it to 80 characters; this is 81.");
    expect(screen.getByText("81 of 80 characters")).toBeTruthy();
  });

  it("submits on Enter in the name", async () => {
    const { name, onCreate } = show();
    fireEvent.change(name, { target: { value: "Garden" } });
    fireEvent.submit(name.form!);
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith({ name: "Garden", type: "project" }));
  });

  it("puts the server's refusal of the name on the field, not at the foot", async () => {
    const onCreate = vi.fn().mockRejectedValue(new FieldError("There is already a project called “Garden”. Pick another name.", "name", "taken"));
    const { name, create } = show(onCreate);
    fireEvent.change(name, { target: { value: "Garden" } });
    fireEvent.click(create);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("already a project called “Garden”"));
    expect(document.querySelector(".ops-alert")).toBeNull();
    expect(create.disabled).toBe(true);
  });
});
