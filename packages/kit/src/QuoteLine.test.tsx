// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { QuoteLine, quoteSource } from "./kit.js";

afterEach(cleanup);

describe("quoteSource", () => {
  it("names a page by its site and an app as it was given", () => {
    expect(quoteSource("https://www.kos.dev/docs/workers?x=1")).toBe("kos.dev");
    expect(quoteSource("http://127.0.0.1:4317/#/chats")).toBe("127.0.0.1");
    expect(quoteSource("Notes: Draft")).toBe("Notes: Draft");
  });
});

describe("QuoteLine", () => {
  it("heads a sent quote with its source and keeps every word for the clamp", () => {
    const text = "word ".repeat(200).trim();
    const { container } = render(<QuoteLine text={text} from="https://kos.dev/a" />);
    expect(container.querySelector(".quoted-label")?.textContent).toBe("kos.dev");
    expect(container.querySelector(".quoted-text")?.textContent).toBe(text);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("is labelled as the composer's attachment, and its × leaves it out", () => {
    const remove = vi.fn();
    const { container } = render(<QuoteLine text="may see and work" from="kos.dev" label="Selected text" lines={2} onRemove={remove} />);
    expect(container.querySelector(".quoted-label")?.textContent).toBe("Selected text");
    expect(container.querySelector(".quoted-from")?.textContent).toBe("kos.dev");
    fireEvent.click(screen.getByRole("button", { name: "Leave the selection out" }));
    expect(remove).toHaveBeenCalledOnce();
  });
});
