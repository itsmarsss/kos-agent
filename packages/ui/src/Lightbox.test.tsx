// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { StepPicture } from "@kos/kit";

import { PictureGallery } from "./Lightbox.js";

afterEach(cleanup);

/** A turn's three pictures in a gallery, as the chat thread holds them. */
function turn(): void {
  render(
    <PictureGallery>
      <StepPicture src="/api/frames/1" caption="Open the pricing page" at={Date.UTC(2026, 10, 18, 15, 4)} />
      <StepPicture src="/api/frames/2" caption="Scroll to the table" />
      <StepPicture src="/api/frames/3" caption="Zoom out" />
    </PictureGallery>,
  );
}

const shown = (): string | null | undefined => document.querySelector(".lightbox-img")?.getAttribute("src");

describe("a step's picture, full size", () => {
  it("opens over the page at the picture pressed, with its words and where it stands", () => {
    turn();
    fireEvent.click(screen.getAllByRole("button")[1]!);
    expect(screen.getByRole("dialog", { name: "Step picture" })).toBeTruthy();
    expect(shown()).toBe("/api/frames/2");
    expect(document.querySelector(".lightbox-count")?.textContent).toBe("2 of 3");
    expect(document.querySelector(".lightbox-caption")?.textContent).toBe("Scroll to the table");
  });

  it("moves through the turn's pictures by the arrows and their keys, and stops at the ends", () => {
    turn();
    fireEvent.click(screen.getAllByRole("button")[0]!);
    const box = screen.getByRole("dialog");
    expect(screen.getByRole("button", { name: "Previous picture" }).hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(box, { key: "ArrowRight" });
    expect(shown()).toBe("/api/frames/2");
    fireEvent.click(screen.getByRole("button", { name: "Next picture" }));
    expect(shown()).toBe("/api/frames/3");
    fireEvent.keyDown(box, { key: "ArrowRight" });
    expect(document.querySelector(".lightbox-count")?.textContent).toBe("3 of 3");
    fireEvent.keyDown(box, { key: "ArrowLeft" });
    expect(shown()).toBe("/api/frames/2");
  });

  it("zooms in on a press and fits the picture again on another", () => {
    turn();
    fireEvent.click(screen.getAllByRole("button")[0]!);
    const img = document.querySelector<HTMLImageElement>(".lightbox-img")!;
    fireEvent.pointerDown(img, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(img, { pointerId: 1, clientX: 10, clientY: 10 });
    expect(img.classList.contains("is-zoomed")).toBe(true);
    fireEvent.pointerDown(img, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(img, { pointerId: 1, clientX: 10, clientY: 10 });
    expect(img.classList.contains("is-zoomed")).toBe(false);
  });

  it("swipes to the next picture when it is not zoomed", () => {
    turn();
    fireEvent.click(screen.getAllByRole("button")[0]!);
    const img = document.querySelector<HTMLImageElement>(".lightbox-img")!;
    fireEvent.pointerDown(img, { pointerId: 1, clientX: 300, clientY: 100 });
    fireEvent.pointerMove(img, { pointerId: 1, clientX: 150, clientY: 105 });
    fireEvent.pointerUp(img, { pointerId: 1, clientX: 150, clientY: 105 });
    expect(shown()).toBe("/api/frames/2");
  });

  it("closes on Escape or a press outside the picture, and gives the focus back to the thumbnail", async () => {
    turn();
    const thumb = screen.getAllByRole("button")[2]!;
    thumb.focus();
    fireEvent.click(thumb);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(thumb);
    fireEvent.click(thumb);
    fireEvent.click(document.querySelector(".lightbox-dim")!);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("offers the picture to download and to copy", () => {
    turn();
    fireEvent.click(screen.getAllByRole("button")[0]!);
    expect(screen.getByRole("link", { name: "Download" }).getAttribute("href")).toBe("/api/frames/1");
    expect(screen.getByRole("button", { name: "Copy image" })).toBeTruthy();
  });
});

describe("a step's picture outside a gallery", () => {
  it("grows in place, as KOS for Chrome's panel has it", () => {
    const { container } = render(<StepPicture src="/api/frames/9" />);
    fireEvent.click(screen.getByRole("button"));
    expect(container.querySelector(".step-picture.is-open")).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
