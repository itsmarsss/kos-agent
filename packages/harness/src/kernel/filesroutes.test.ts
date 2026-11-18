import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runRequest } from "../files/viewer/convert.js";
import { keynote, sampleDocx } from "../files/viewer/office.fixture.js";
import { OfficeViewer } from "../files/viewer/viewer.js";
import { Workspace } from "../store/workspace.js";
import { handleFilesRoute, type FilesDeps, type FilesResponse } from "./filesroutes.js";

describe("the file manager's routes", () => {
  let root: string;
  let outside: string;
  let ws: Workspace;
  let deps: FilesDeps;

  const get = (path: string, query: Record<string, string> = {}): Promise<FilesResponse | undefined> =>
    handleFilesRoute(ws, { method: "GET", path, query: new URLSearchParams(query), body: {} }, deps);
  const post = (path: string, body: Record<string, unknown>): Promise<FilesResponse | undefined> =>
    handleFilesRoute(ws, { method: "POST", path, query: new URLSearchParams(), body }, deps);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-filesroutes-"));
    outside = mkdtempSync(join(tmpdir(), "kos-outside-"));
    ws = Workspace.open(root);
    mkdirSync(join(root, "projects/garden/beds"), { recursive: true });
    writeFileSync(join(root, "projects/garden/plan.docx"), sampleDocx());
    writeFileSync(join(root, "projects/garden/beds/tomato notes.md"), "Water the Tomatoes daily.");
    writeFileSync(join(root, "projects/garden/talk.key"), keynote());
    writeFileSync(join(outside, "secret.md"), "tomato secret");
    symlinkSync(outside, join(root, "projects/garden/link"));
    deps = { viewer: new OfficeViewer({ run: async (req) => runRequest(req) }), projectName: (slug) => (slug === "garden" ? "Garden" : undefined) };
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("serves an Office view as inert JSON", async () => {
    const res = await get("/api/file/office", { path: "projects/garden/plan.docx" });
    expect(res?.status).toBe(200);
    expect(res?.headers).toEqual({ "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" });
    expect(res?.body).toMatchObject({ kind: "doc", format: "docx" });
  });

  it("refuses traversal, absolute paths and links out of the workspace on every read", async () => {
    for (const path of ["../x.docx", "projects/garden/link/secret.md", "projects/garden/link"]) {
      for (const route of ["/api/file/office", "/api/file/thumb", "/api/files/info", "/api/files/search"]) {
        const res = await get(route, { path, q: "tomato" });
        expect(res?.status, `${route} ${path}`).toBe(400);
      }
    }
    // A leading slash means the workspace's top, as it does for /api/files: the outside folder's name is looked for inside.
    const absolute = await get("/api/files/search", { path: outside, q: "secret" });
    expect(absolute?.body).toEqual({ entries: [], truncated: false });
  });

  it("never walks through a link when searching", async () => {
    const names = (await get("/api/files/search", { path: "projects", q: "TOMATO" }))?.body as { entries: { path: string }[] };
    expect(names.entries.map((e) => e.path)).toEqual(["projects/garden/beds/tomato notes.md"]);
    const contents = (await get("/api/files/search", { path: ".", q: "tomatoes", contents: "1" }))?.body as { entries: { path: string; line: number; text: string }[] };
    expect(contents.entries).toEqual([expect.objectContaining({ path: "projects/garden/beds/tomato notes.md", line: 1, text: "Water the Tomatoes daily." })]);
  });

  it("lists the latest files and gives one's facts with its project", async () => {
    const recents = (await get("/api/files/recents"))?.body as { entries: { path: string }[] };
    expect(recents.entries.map((e) => e.path).sort()).toEqual(["projects/garden/beds/tomato notes.md", "projects/garden/plan.docx", "projects/garden/talk.key"]);
    const info = (await get("/api/files/info", { path: "projects/garden/plan.docx" }))?.body;
    expect(info).toMatchObject({ name: "plan.docx", kind: "file", project: { slug: "garden", name: "Garden" } });
    expect((await get("/api/files/info", { path: "projects/garden" }))?.body).toMatchObject({ kind: "dir", items: 4 });
  });

  it("draws a Keynote file's thumbnail from its own preview, and none for a plain file", async () => {
    const thumb = await get("/api/file/thumb", { path: "projects/garden/talk.key", size: "256" });
    expect(thumb?.status).toBe(200);
    expect(thumb?.headers?.["content-type"]).toBe("image/jpeg");
    expect(thumb?.headers?.["x-content-type-options"]).toBe("nosniff");
    expect((await get("/api/file/thumb", { path: "projects/garden/beds/tomato notes.md" }))?.status).toBe(404);
  });

  it("asks QuickLook for a document once per version", async () => {
    const quickLook = vi.fn(async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    deps = { ...deps, quickLook };
    for (let i = 0; i < 2; i++) expect((await get("/api/file/thumb", { path: "projects/garden/plan.docx" }))?.headers?.["content-type"]).toBe("image/png");
    expect(quickLook).toHaveBeenCalledTimes(1);
    expect(existsSync(join(root, ".kos/cache/thumbs"))).toBe(true);
  });

  it("moves to the trash, restores beside a newcomer, and empties only when told", async () => {
    const trashed = (await post("/api/files/trash", { path: "projects/garden/beds" }))?.body as { id: string };
    expect(existsSync(join(root, "projects/garden/beds"))).toBe(false);
    const list = (await get("/api/files/trash"))?.body as { items: { id: string; path: string; kind: string }[] };
    expect(list.items).toEqual([expect.objectContaining({ id: trashed.id, path: "projects/garden/beds", kind: "dir" })]);

    mkdirSync(join(root, "projects/garden/beds"));
    expect((await post("/api/files/restore", { id: trashed.id }))?.body).toEqual({ path: "projects/garden/beds (2)" });
    expect(readFileSync(join(root, "projects/garden/beds (2)/tomato notes.md"), "utf8")).toContain("Tomatoes");

    await post("/api/files/trash", { path: "projects/garden/plan.docx" });
    expect((await post("/api/files/empty-trash", {}))?.status).toBe(400);
    expect(((await get("/api/files/trash"))?.body as { items: unknown[] }).items).toHaveLength(1);
    expect((await post("/api/files/empty-trash", { confirm: true }))?.body).toEqual({ removed: 1 });
    expect(((await get("/api/files/trash"))?.body as { items: unknown[] }).items).toEqual([]);
  });

  it("refuses to trash the workspace's own files, its layout, a link or a path out", async () => {
    for (const path of [".kos/trash", "kos.sqlite", "KOS.sqlite", ".", "projects", "../x", "projects/garden/link/secret.md"]) {
      expect((await post("/api/files/trash", { path }))?.status, path).toBe(400);
    }
    expect(existsSync(join(outside, "secret.md"))).toBe(true);
    for (const id of ["../../etc", "1", { $ne: 1 }]) expect((await post("/api/files/restore", { id }))?.status).toBe(400);
  });

  it("leaves other paths to the server", async () => {
    expect(await get("/api/files")).toBeUndefined();
    expect(await post("/api/files/rename", {})).toBeUndefined();
  });
});
