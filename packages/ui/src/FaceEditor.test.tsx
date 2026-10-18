// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SWATCHES } from "./ColourPicker.js";
import { FaceEditor, hexOfHue } from "./FaceEditor.js";
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
    expect(SWATCHES.some((s) => s.hue === 100)).toBe(false);
    expect(hueOfHex(hexOfHue(100))).toBe(100);
  });

  it("opens a picker of its own under Custom and takes any colour from it", () => {
    const onChange = vi.fn();
    render(<FaceEditor seed="kos" value={{ hue: 285 }} onChange={onChange} />);
    expect(screen.queryByLabelText("Colour as hex")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Custom/ }));
    const hex = screen.getByLabelText("Colour as hex") as HTMLInputElement;
    // It opens on the face's own colour.
    expect(hueOfHex(hex.value)).toBe(285);
    fireEvent.change(hex, { target: { value: "#ff8000" } });
    expect(onChange).toHaveBeenCalledWith({ hue: 285, colour: "#ff8000" });
    // Half a hex is not a colour yet, so nothing is sent for it.
    fireEvent.change(hex, { target: { value: "#ff80" } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("wears a picked colour on Custom, and a swatch press lets it go", () => {
    const onChange = vi.fn();
    render(<FaceEditor seed="kos" value={{ colour: "#8b5cf6" }} onChange={onChange} />);
    const custom = screen.getByRole("button", { name: /Custom/ });
    expect(custom.className).toContain("is-on");
    expect(custom.textContent).toContain("#8b5cf6");
    expect(screen.getByRole("button", { name: "blue" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "teal" }));
    expect(onChange).toHaveBeenCalledWith({ hue: 180 });
  });
});
