// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { checkOrigin, OriginList, PAYMENT_FRAMES, SecretField, takeSecretValues } from "./Secrets.js";

afterEach(cleanup);

describe("a secret's field", () => {
  it("is masked, unremembered and unchecked, and blank says unchanged with the hint", () => {
    render(<SecretField label="Card number" name="number" set hint="•••• 4242" />);
    const input = screen.getByLabelText(/^Card number/) as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.getAttribute("autocomplete")).toBe("off");
    expect(input.getAttribute("spellcheck")).toBe("false");
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("Unchanged (•••• 4242)");
    expect(input.required).toBe(false);
    expect(input.closest("label")!.querySelector(".hint")).toBeNull();
  });

  it("is required when nothing is kept yet, and shows a plain one as typed", () => {
    render(
      <>
        <SecretField label="Password" name="password" required />
        <SecretField label="Username" name="username" plain />
      </>,
    );
    expect((screen.getByLabelText(/Password/) as HTMLInputElement).required).toBe(true);
    expect((screen.getByLabelText("Username") as HTMLInputElement).type).toBe("text");
  });

  it("takes a seed once, into the field and nowhere else", () => {
    const { container } = render(<SecretField label="Token" name="token" seed="sk-live-123" />);
    expect((screen.getByLabelText("Token") as HTMLInputElement).value).toBe("sk-live-123");
    expect(container.innerHTML).not.toContain("sk-live-123");
  });

  it("gives up its values to the submit and is cleared by it", () => {
    const onValues = vi.fn();
    render(
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onValues(takeSecretValues(e.currentTarget));
        }}
      >
        <SecretField label="Username" name="username" plain />
        <SecretField label="Password" name="password" />
        <button type="submit">Save</button>
      </form>,
    );
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "hunter2" } });
    fireEvent.click(screen.getByText("Save"));
    expect(onValues).toHaveBeenCalledWith({ password: "hunter2" });
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");
  });
});

describe("an origin as kept", () => {
  it("takes https, exact or one wildcard level, and http only for localhost", () => {
    expect(checkOrigin("https://Example.com/")).toEqual({ ok: "https://example.com" });
    expect(checkOrigin("https://*.example.com")).toEqual({ ok: "https://*.example.com" });
    expect(checkOrigin("https://shop.example.com:8443")).toEqual({ ok: "https://shop.example.com:8443" });
    expect(checkOrigin("http://localhost:3000")).toEqual({ ok: "http://localhost:3000" });
    expect(checkOrigin("http://example.com")).toHaveProperty("error");
    expect(checkOrigin("example.com")).toHaveProperty("error");
    expect(checkOrigin("https://example.com/login")).toHaveProperty("error");
    expect(checkOrigin("https://*.com")).toHaveProperty("error");
    expect(checkOrigin("https://a.*.example.com")).toHaveProperty("error");
    expect(checkOrigin("ftp://example.com")).toHaveProperty("error");
  });

  it("takes bare hosts and bundle ids in their modes", () => {
    expect(checkOrigin("https://api.github.com", "host")).toEqual({ ok: "api.github.com" });
    expect(checkOrigin("*.stripe.com", "host")).toEqual({ ok: "*.stripe.com" });
    expect(checkOrigin("not a host", "host")).toHaveProperty("error");
    expect(checkOrigin("com.apple.Safari", "bundle")).toEqual({ ok: "com.apple.Safari" });
    expect(checkOrigin("Safari", "bundle")).toHaveProperty("error");
  });
});

describe("a list of origins", () => {
  function Harness({ presets }: { presets?: typeof PAYMENT_FRAMES }): React.ReactElement {
    const [value, setValue] = useState<string[]>(["https://github.com"]);
    return (
      <>
        <OriginList label="Sites" value={value} onChange={setValue} {...(presets ? { presets } : {})} />
        <output data-testid="value">{value.join(",")}</output>
      </>
    );
  }

  it("adds a checked one, refuses a bad one with why, and removes one", () => {
    render(<Harness />);
    const add = screen.getByLabelText("Add to Sites");
    fireEvent.change(add, { target: { value: "http://example.com" } });
    fireEvent.click(screen.getByText("Add"));
    expect(screen.getByRole("alert").textContent).toBe("Only https, or http://localhost.");
    fireEvent.change(add, { target: { value: "https://*.example.com" } });
    fireEvent.keyDown(add, { key: "Enter" });
    expect(screen.getByTestId("value").textContent).toBe("https://github.com,https://*.example.com");
    fireEvent.click(screen.getByLabelText("Remove https://github.com"));
    expect(screen.getByTestId("value").textContent).toBe("https://*.example.com");
  });

  it("ticks the common payment frames", () => {
    render(<Harness presets={PAYMENT_FRAMES} />);
    fireEvent.click(screen.getAllByRole("checkbox")[0]!);
    expect(screen.getByTestId("value").textContent).toBe("https://github.com,https://js.stripe.com");
    expect(screen.getByText("PayPal")).toBeTruthy();
    expect(screen.getByText("*.braintreegateway.com")).toBeTruthy();
  });
});
