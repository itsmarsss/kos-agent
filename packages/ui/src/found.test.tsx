// @vitest-environment jsdom
import { cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api, HttpError } from "./api.js";
import { FilesPage } from "./FilesPage.js";
import { isGone, useFound } from "./found.js";
import { parseRoute } from "./routes.js";
import { isSettingsSection } from "./settingsindex.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("whether an address's thing is there", () => {
  it("counts only KOS's not-there answers as gone, never a broken line or a refused key", () => {
    expect([new HttpError(404, "x"), new HttpError(400, "ENOENT"), new HttpError(401, "x"), new HttpError(500, "x"), new Error("offline")].map(isGone)).toEqual([true, true, false, false, false]);
  });

  it("asks once per key: asking, then here or gone", async () => {
    const { result, rerender } = renderHook(({ key, ok }) => useFound(key, () => (ok ? Promise.resolve(true) : Promise.reject(new HttpError(404, "no")))), { initialProps: { key: "a" as string | null, ok: true } });
    expect(result.current).toBe("asking");
    await waitFor(() => expect(result.current).toBe("here"));
    rerender({ key: "b", ok: false });
    expect(result.current).toBe("asking");
    await waitFor(() => expect(result.current).toBe("gone"));
    rerender({ key: null, ok: false });
    expect(result.current).toBe("here");
  });
});

describe("a bad link", () => {
  it("names no page rather than opening the overview", () => {
    expect(parseRoute("#/builds/nope")).toEqual({ name: "missing", path: "/builds/nope" });
    expect(parseRoute("#/inbox/abc")).toEqual({ name: "missing", path: "/inbox/abc" });
    expect(parseRoute("#/nowhere")).toEqual({ name: "missing", path: "/nowhere" });
    expect(parseRoute("#/inbox/99999")).toEqual({ name: "inbox", id: 99999 });
    expect(isSettingsSection("nope")).toBe(false);
  });

  it("to a file that is not there says so, not the workspace root", async () => {
    vi.spyOn(api, "fileInfo").mockRejectedValue(new HttpError(400, "ENOENT: no such file or directory, stat '/w/nope'"));
    render(<FilesPage path="nope/folder" onOpen={() => {}} />);
    expect(await screen.findByText("No file or folder called “nope/folder”")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back to Files" })).toBeTruthy();
  });
});
