// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Field } from "./Field.js";

afterEach(cleanup);

const described = (el: HTMLElement): string =>
  (el.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");

describe("a field", () => {
  it("names its control by the label alone, the hint as its description", () => {
    render(
      <Field label="Name" required hint="How it is named in lists.">
        <input />
      </Field>,
    );
    const box = screen.getByRole("textbox", { name: "Name" });
    expect(box.getAttribute("aria-required")).toBe("true");
    expect(box.getAttribute("aria-invalid")).toBeNull();
    expect(described(box)).toBe("How it is named in lists.");
  });

  it("ties an error to its control in place of the hint, and marks it invalid", () => {
    render(
      <Field label="Schedule line" hint="Five parts." error="A schedule line has five parts. This has 3.">
        <input />
      </Field>,
    );
    const box = screen.getByRole("textbox", { name: "Schedule line" });
    expect(box.getAttribute("aria-invalid")).toBe("true");
    expect(described(box)).toBe("A schedule line has five parts. This has 3.");
    expect(screen.getByRole("alert").textContent).toBe("A schedule line has five parts. This has 3.");
  });

  it("keeps what a control says of itself", () => {
    render(
      <Field label="Name" hint="A hint">
        <input aria-describedby="elsewhere" />
      </Field>,
    );
    expect(screen.getByRole("textbox", { name: "Name" }).getAttribute("aria-describedby")).toBe("elsewhere");
  });

  it("names a group of controls by its label", () => {
    render(
      <Field label="How often" group hint="Pick one">
        <button type="button">Every day</button>
        <button type="button">Weekdays</button>
      </Field>,
    );
    expect(screen.getByRole("group", { name: "How often" })).toBeTruthy();
  });
});
