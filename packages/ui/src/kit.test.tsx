// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Card, Empty, Field, Pill, Tag } from "./kit.js";

afterEach(cleanup);

describe("the kit", () => {
  it("marks a required field, and shows an error in place of the hint", () => {
    const { rerender } = render(
      <Field label="Name" required hint="Short and plain.">
        <input />
      </Field>,
    );
    expect(screen.getByLabelText("required")).toBeTruthy();
    expect(screen.getByText("Short and plain.")).toBeTruthy();
    expect(screen.getByLabelText(/Name/)).toBeTruthy();
    rerender(
      <Field label="Name" required hint="Short and plain." error="That name is taken.">
        <input />
      </Field>,
    );
    expect(screen.getByRole("alert").textContent).toBe("That name is taken.");
    expect(screen.queryByText("Short and plain.")).toBeNull();
  });

  it("labels a group of controls without wrapping them in one label", () => {
    render(
      <Field label="Colour" group>
        <button type="button">red</button>
        <button type="button">blue</button>
      </Field>,
    );
    expect(screen.getByRole("group", { name: "Colour" })).toBeTruthy();
  });

  it("heads a card with a title, a count, a pill and an action", () => {
    render(
      <Card title="Folder" count={2} pill={<Pill tone="ok">on</Pill>} action={<button type="button">Open</button>}>
        <p>body</p>
      </Card>,
    );
    const card = screen.getByRole("region", { name: "Folder" });
    expect(card.querySelector(".card-title")?.textContent).toBe("Folder2");
    expect(card.querySelector(".pill--ok")?.textContent).toBe("on");
    expect(screen.getByRole("button", { name: "Open" })).toBeTruthy();
  });

  it("writes a tag and an empty state", () => {
    render(
      <>
        <Tag mono>browser</Tag>
        <Empty title="All clear">Nothing is waiting on you.</Empty>
      </>,
    );
    expect(screen.getByText("browser").className).toBe("tag tag--mono");
    expect(screen.getByText("All clear").className).toBe("empty-title");
    expect(screen.getByText("Nothing is waiting on you.")).toBeTruthy();
  });
});
