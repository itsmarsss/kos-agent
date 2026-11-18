import { describe, expect, it } from "vitest";

import { placePath, reachWords, ROOT_HOME, type FileHome } from "./filehome.js";
import { summarizeAction } from "./format-action.js";

const school: FileHome = { folder: "projects/school" };
const at = (home: FileHome, path: string, root?: string): string => placePath(home, path, root).path;

describe("placePath", () => {
  it("puts a relative path inside the home", () => {
    expect(placePath(school, "bu252/mokable/doc.md")).toEqual({ path: "projects/school/bu252/mokable/doc.md", explicit: false, outside: false });
    expect(at(school, "./notes.md")).toBe("projects/school/notes.md");
    expect(at(school, ".")).toBe("projects/school");
    expect(at(school, "")).toBe("projects/school");
  });

  it("reads a path that starts with the project's own name as inside it, in any case", () => {
    expect(placePath(school, "school/bu252/x.md")).toEqual({ path: "projects/school/bu252/x.md", explicit: false, outside: false });
    expect(at(school, "School/x.md")).toBe("projects/school/x.md");
  });

  it("never doubles a path already written from the root", () => {
    expect(placePath(school, "projects/school/x.md")).toEqual({ path: "projects/school/x.md", explicit: true, outside: false });
    expect(at(school, "workspace:projects/school/x.md")).toBe("projects/school/x.md");
  });

  it("reads workspace: and KOS's own folders from the root, outside the home", () => {
    expect(placePath(school, "workspace:notes/x.md")).toEqual({ path: "notes/x.md", explicit: true, outside: true });
    expect(placePath(school, "WORKSPACE:/drafts/a.md")).toEqual({ path: "drafts/a.md", explicit: true, outside: true });
    expect(placePath(school, "projects/resume/cv.md")).toEqual({ path: "projects/resume/cv.md", explicit: true, outside: true });
    expect(placePath(school, "scratch/python/run/chart.png").outside).toBe(true);
    expect(placePath(school, "skills/pdf/SKILL.md").path).toBe("skills/pdf/SKILL.md");
  });

  it("takes an absolute path inside the root as that path, and leaves one outside for the jail", () => {
    expect(placePath(school, "/ws/projects/resume/cv.md", "/ws")).toEqual({ path: "projects/resume/cv.md", explicit: true, outside: true });
    expect(placePath(school, "/ws/projects/school/a.md", "/ws/").outside).toBe(false);
    expect(placePath(school, "/etc/passwd", "/ws")).toEqual({ path: "/etc/passwd", explicit: true, outside: true });
    expect(placePath(ROOT_HOME, "/etc/passwd", "/ws").outside).toBe(false);
    expect(placePath(school, "/wsx/a", "/ws").path).toBe("/wsx/a");
  });

  it("reads an absolute path however it is spelled, and never takes an unrecognised one for inside", () => {
    for (const spelled of ["//ws/projects/resume/cv.md", "/./ws/projects/resume/cv.md", "/ws//projects/./resume/cv.md", "/ws/./projects/resume/cv.md"]) {
      expect(placePath(school, spelled, "/ws"), spelled).toEqual({ path: "projects/resume/cv.md", explicit: true, outside: true });
    }
    expect(placePath(school, "//ws/projects/school/a.md", "/ws/").outside).toBe(false);
    expect(placePath(school, "/ws/../ws/projects/resume/cv.md", "/ws").outside).toBe(true);
    // No root to compare with: outside, whatever it names.
    expect(placePath(school, "/ws/projects/school/a.md").outside).toBe(true);
  });

  it("folds names as a case-folding disk does, the long s included", () => {
    expect(placePath(school, "workspace:project\u017f/other/x").outside).toBe(true);
    expect(placePath(school, "PROJECTS/School/x.md")).toEqual({ path: "PROJECTS/School/x.md", explicit: true, outside: false });
    expect(placePath(school, "project\u017f/school/x.md").outside).toBe(false);
  });

  it("hands back a padded absolute path trimmed, so it is never read as a relative one", () => {
    expect(placePath(school, "  /etc/kos.md", "/ws")).toEqual({ path: "/etc/kos.md", explicit: true, outside: true });
  });

  it("keeps a parent step for the jail to refuse rather than resolving it", () => {
    expect(at(school, "../resume/cv.md")).toBe("projects/school/../resume/cv.md");
  });

  it("leaves a root chat's paths as written", () => {
    expect(placePath(ROOT_HOME, "school/x.md")).toEqual({ path: "school/x.md", explicit: false, outside: false });
    expect(placePath(ROOT_HOME, "workspace:notes/x.md")).toEqual({ path: "notes/x.md", explicit: true, outside: false });
  });

  it("counts a blob's own folder as the home's too", () => {
    const blob: FileHome = { folder: "projects/school", also: ["blobs/noter"] };
    expect(placePath(blob, "blobs/noter/log.md").outside).toBe(false);
    expect(placePath(blob, "blobs/other/log.md").outside).toBe(true);
    expect(at({ folder: "blobs/noter" }, "noter/log.md")).toBe("blobs/noter/log.md");
  });
});

describe("reachWords", () => {
  it("says nothing inside the home, where a read reads from, and whose folder a change lands in", () => {
    expect(reachWords(school, placePath(school, "x.md"), "change")).toBeUndefined();
    expect(reachWords(school, placePath(school, "projects/resume/cv.md"), "read")).toBe("reads from projects/resume");
    expect(reachWords(school, placePath(school, "projects/resume/cv.md"), "change")).toBe("outside this project, in the resume project");
    expect(reachWords(school, placePath(school, "workspace:notes.md"), "change")).toBe("outside this project, in the workspace root");
    expect(reachWords(school, placePath(school, "workspace:drafts/a.md"), "change")).toBe("outside this project, in drafts/");
    expect(reachWords({ folder: "blobs/noter" }, placePath({ folder: "blobs/noter" }, "workspace:a.md"), "change")).toBe("outside this blob's folder, in the workspace root");
  });
});

describe("summarizeAction with a home", () => {
  const where = { home: school, root: "/ws" };

  it("names the path a step really reaches", () => {
    expect(summarizeAction("files.write", { path: "bu252/x.md" }, undefined, where)).toBe("Write file projects/school/bu252/x.md");
    expect(summarizeAction("files.write", { path: "school/x.md" }, undefined, where)).toBe("Write file projects/school/x.md");
    expect(summarizeAction("files.ls", {}, undefined, where)).toBe("List projects/school");
  });

  it("labels a read outside the home with where it reads from", () => {
    expect(summarizeAction("files.read", { path: "projects/resume/cv.md" }, undefined, where)).toBe("Read projects/resume/cv.md (reads from projects/resume)");
  });

  it("labels a change outside the home with whose folder it lands in", () => {
    expect(summarizeAction("files.write", { path: "projects/resume/cv.md" }, undefined, where)).toBe("Write file projects/resume/cv.md (outside this project, in the resume project)");
    expect(summarizeAction("files.mv", { from: "a.md", to: "workspace:drafts/a.md" }, undefined, where)).toBe("Move projects/school/a.md → drafts/a.md (outside this project, in drafts/)");
    expect(summarizeAction("shell.run", { command: "ls" }, undefined, where)).toBe("Run: ls (in projects/school)");
    expect(summarizeAction("shell.run", { command: "make", writes: "workspace" }, undefined, where)).toBe("Run: make (in projects/school), writing anywhere in the workspace");
  });

  it("leaves a root chat's steps as they were", () => {
    const root = { home: ROOT_HOME };
    expect(summarizeAction("files.write", { path: "school/x.md" }, undefined, root)).toBe("Write file school/x.md");
    expect(summarizeAction("shell.run", { command: "ls" }, undefined, root)).toBe("Run: ls");
    expect(summarizeAction("files.ls", {}, undefined, root)).toBe(summarizeAction("files.ls", {}));
  });
});
