// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SheetFoot } from "./Sheet.js";

afterEach(cleanup);

describe("a sheet's foot", () => {
  it("says why its primary is held, tied to the button", () => {
    render(<SheetFoot onCancel={() => undefined} held="Give it a name first." primary={<button type="submit" disabled>Create</button>} />);
    const create = screen.getByRole("button", { name: "Create" });
    expect(document.getElementById(create.getAttribute("aria-describedby")!)?.textContent).toBe("Give it a name first.");
  });

  it("shows its note, and ties nothing, once nothing holds it", () => {
    render(<SheetFoot note="Goes to Workspace" primary={<button type="submit">Create</button>} />);
    expect(screen.getByText("Goes to Workspace")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create" }).getAttribute("aria-describedby")).toBeNull();
  });
});
