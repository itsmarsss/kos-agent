// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useCreateParam } from "./hashparams.js";
import { KeysSheet } from "./KeysSheet.js";
import { isLooseKey, keyWords, SHORTCUTS } from "./shortcuts.js";

afterEach(cleanup);

describe("the keys sheet", () => {
  it("lists every place's keys, each with what it does", () => {
    render(<KeysSheet open onClose={() => undefined} />);
    for (const group of SHORTCUTS) {
      expect(screen.getByText(group.where)).toBeTruthy();
      expect(group.keys.length).toBeGreaterThan(0);
    }
    expect(screen.getByText("Shut the menu or sheet on top")).toBeTruthy();
  });

  it("hears a page's key only with nothing to type into and no other key held", () => {
    const field = document.createElement("input");
    document.body.append(field);
    const on = (target: EventTarget, init: KeyboardEventInit): boolean => {
      const e = new KeyboardEvent("keydown", { ...init, bubbles: true });
      Object.defineProperty(e, "target", { value: target });
      return isLooseKey(e);
    };
    expect(on(document.body, { key: "?" })).toBe(true);
    expect(on(field, { key: "?" })).toBe(false);
    expect(on(document.body, { key: "/", metaKey: true })).toBe(false);
    field.remove();
  });
});

function Page({ open }: { open: () => void }): null {
  useCreateParam(open);
  return null;
}

describe("a keycap in words", () => {
  it("says each symbol as its key's name", () => {
    expect(keyWords("⌘⇧K")).toBe("Command Shift K");
    expect(keyWords("⌘⌫")).toBe("Command Delete");
    expect(keyWords("⇧F10")).toBe("Shift F10");
    expect(keyWords("Esc")).toBe("Esc");
    expect(keyWords("Home")).toBe("Home");
  });
});

describe("a page's create, asked for by its address", () => {
  it("opens once and comes off the address", () => {
    window.location.hash = "#/projects?new=1";
    const open = vi.fn();
    render(<Page open={open} />);
    expect(open).toHaveBeenCalledOnce();
    expect(window.location.hash).toBe("#/projects");
    act(() => void window.dispatchEvent(new HashChangeEvent("hashchange")));
    expect(open).toHaveBeenCalledOnce();
  });
});
