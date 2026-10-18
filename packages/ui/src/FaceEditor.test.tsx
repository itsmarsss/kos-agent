// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FaceEditor, SWATCHES, hexOfHue } from "./FaceEditor.js";
import { hueOfHex } from "./colour.js";

afterEach(cleanup);

describe("the face editor", () => {
  it("offers a quick pick of colours, marks the one the face wears, and sets a hue from a press", () => {
    const onChange = vi.fn();
    render(<FaceEditor seed="kos" value={{}} onChange={onChange} />);
    expect(screen.getAllByRole("button", { pressed: false }).length).toBeGreaterThan(5);
    // KOS is blue by default, which is a swatch.
    expect(screen.getByRole("button", { name: "blue" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "pink" }));
    expect(onChange).toHaveBeenCalledWith({ hue: 330 });
  });

  it("takes any colour from the picker as its hue, and shows the picker as the face's colour", () => {
    const onChange = vi.fn();
    render(<FaceEditor seed="kos" value={{ hue: 285 }} onChange={onChange} />);
    const picker = screen.getByLabelText("Any colour") as HTMLInputElement;
    expect(hueOfHex(picker.value)).toBe(285);
    fireEvent.change(picker, { target: { value: "#ff8000" } });
    expect(onChange).toHaveBeenCalledWith({ hue: 30 });
    // A grey has no hue, so it changes nothing.
    fireEvent.change(picker, { target: { value: "#777777" } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("marks the custom swatch when the hue is not a quick pick", () => {
    render(<FaceEditor seed="kos" value={{ hue: 100 }} onChange={() => {}} />);
    expect(SWATCHES.some((s) => s.hue === 100)).toBe(false);
    expect(screen.getByTitle("Any colour").className).toContain("is-on");
    expect(hueOfHex(hexOfHue(100))).toBe(100);
  });
});
