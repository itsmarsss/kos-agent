// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useAttachments } from "./Attachments.js";
import { backInComposer, detectSecret, luhn, withoutSecret } from "./composer.js";
import { SecretOffer } from "./SecretOffer.js";

describe("a send that failed", () => {
  const photo = { name: "cart.png", mediaType: "image/png", data: "iVBORw0KGgo=" };

  it("puts the words back in the composer, unless something new was typed since", () => {
    expect(backInComposer("", "skip the ebooks")).toBe("skip the ebooks");
    expect(backInComposer("  ", "skip the ebooks")).toBe("skip the ebooks");
    expect(backInComposer("and the red one", "skip the ebooks")).toBe("and the red one");
  });

  it("puts its files back, unless new ones were attached since", () => {
    const { result } = renderHook(() => useAttachments());
    act(() => result.current.restore([photo]));
    expect(result.current.files).toEqual([photo]);
    act(() => result.current.restore([{ ...photo, name: "other.png" }]));
    expect(result.current.files).toEqual([photo]);
  });
});

describe("a secret in a draft", () => {
  afterEach(cleanup);

  it("finds a Luhn-valid card number, spaced or not, and passes over other digits", () => {
    expect(luhn("4242424242424242")).toBe(true);
    expect(luhn("4242424242424241")).toBe(false);
    expect(detectSecret("pay with 4242 4242 4242 4242 please")).toMatchObject({ kind: "card", field: "number", value: "4242424242424242", start: 9, end: 28 });
    expect(detectSecret("card 378282246310005")).toMatchObject({ kind: "card", value: "378282246310005" });
    expect(detectSecret("order 4242424242424241 shipped")).toBeNull();
    expect(detectSecret("call 555 123 4567 or 2026-11-18")).toBeNull();
    expect(detectSecret("12345678901234567890")).toBeNull();
  });

  it("finds keys by their prefixes, and a password line", () => {
    expect(detectSecret("use sk-proj-abcdefghijklmnop1234")).toMatchObject({ kind: "apikey", field: "token", value: "sk-proj-abcdefghijklmnop1234" });
    expect(detectSecret("ghp_abcdefghijklmnopqrstuvwxyz0123")).toMatchObject({ kind: "apikey", what: "a GitHub token" });
    expect(detectSecret("token xoxb-1234567890-abcdef")).toMatchObject({ kind: "apikey", what: "a Slack token" });
    expect(detectSecret("AKIAIOSFODNN7EXAMPLE")).toMatchObject({ kind: "apikey", what: "an AWS key" });
    expect(detectSecret("login is kenny, password: hunter2!")).toMatchObject({ kind: "login", field: "password", value: "hunter2!" });
    expect(detectSecret("the task-list is long")).toBeNull();
    expect(detectSecret("what is a good password?")).toBeNull();
  });

  it("takes it out of the draft, closing the gap", () => {
    const text = "pay with 4242 4242 4242 4242 please";
    expect(withoutSecret(text, detectSecret(text)!)).toBe("pay with please");
    const pw = "sign in\npassword: hunter2\nthen check out";
    expect(withoutSecret(pw, detectSecret(pw)!)).toBe("sign in\n\nthen check out");
  });

  it("offers to save it instead, out of the draft and into the sheet, in no address", () => {
    const onDraft = vi.fn();
    const before = window.location.href;
    render(<SecretOffer draft="buy it with 4242 4242 4242 4242" onDraft={onDraft} />);
    expect(screen.getByText("This looks like a card number.")).toBeTruthy();
    fireEvent.click(screen.getByText("Save as a secret instead"));
    expect(onDraft).toHaveBeenCalledWith("buy it with");
    expect((screen.getByLabelText(/^Card number/) as HTMLInputElement).value).toBe("4242424242424242");
    expect(screen.getByRole("button", { name: "Card" }).getAttribute("aria-pressed")).toBe("true");
    expect(window.location.href).toBe(before);
    expect(document.body.innerHTML).not.toContain("4242424242424242");
  });

  it("can be turned down", () => {
    render(<SecretOffer draft="ghp_abcdefghijklmnopqrstuvwxyz0123" onDraft={() => undefined} />);
    fireEvent.click(screen.getByLabelText("Send it as it is"));
    expect(screen.queryByText(/This looks like/)).toBeNull();
  });
});
