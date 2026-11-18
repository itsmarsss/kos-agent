import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Kernel } from "../kernel/kernel.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { applyTidy, describeTidy, planTidy } from "./tidy.js";

/**
 * The scratch layout: the misplaced folders the live workspace held, a
 * project folder already in use, and the audit and run records a real turn
 * would have left behind.
 */
describe("tidying a project's files back into its folder", () => {
  let root: string;
  let kernel: Kernel;

  const put = (path: string, text = path): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const audit = (tool: string, args: Record<string, unknown>, at: number, result = "ok"): void => {
    kernel.workspace.db.prepare("INSERT INTO audit_log (tool, args, result, is_error, risk_tier, user_id, created_at) VALUES (?, ?, ?, 0, 'safe', 'owner', ?)").run(tool, JSON.stringify(args), result, at);
  };
  const ran = (kind: "chat" | "cron", ref: string, from: number, to: number | null): void => {
    kernel.workspace.db.prepare("INSERT INTO runs_log (kind, ref, status, started_at, finished_at) VALUES (?, ?, 'ok', ?, ?)").run(kind, ref, from, to);
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-tidy-"));
    kernel = await Kernel.boot({ rootDir: root, secrets: new SecretsRegistry(), chrome: { port: 1, exists: () => false } });
    for (const slug of ["school", "resume"]) kernel.manifest.createProject({ name: slug, type: "notes" });
    const owner = kernel.profile.ownerId;
    const school = kernel.conversations.create({ userId: owner, title: "Mokable", projectSlug: "school" }).id;
    const resume = kernel.conversations.create({ userId: owner, title: "CV", projectSlug: "resume" }).id;
    const root_ = kernel.conversations.create({ userId: owner, title: "Loose" }).id;

    put("school/bu252/mokable/doc.md");
    put("projects/school/bu252/mokable/doc.md", "already here, different");
    put("school/bu354/review.md");
    put("drafts/cover-letter.md");
    put("drafts/ambiguous.md");
    put("drafts/from-root.md");
    put("notes/unknown.md");
    put("scratch/python/run/out.txt");
    put("uploads/photo.png");

    // Runs the host went down under, long before, and one with no chat, cover nothing now.
    ran("chat", root_, -10_000_000, null);
    kernel.workspace.db.prepare("INSERT INTO runs_log (kind, ref, status, started_at) VALUES ('chat', NULL, 'running', 0)").run();
    // A resume chat wrote the cover letter while only it ran.
    ran("chat", resume, 1000, 2000);
    audit("files.write", { path: "drafts/cover-letter.md" }, 1500);
    // Two projects ran at once: nobody can say whose.
    ran("chat", school, 3000, 4000);
    ran("chat", resume, 3000, 4000);
    audit("files.write", { path: "drafts/ambiguous.md" }, 3500);
    // A root chat's own file stays at the root.
    ran("chat", root_, 5000, 6000);
    audit("files.write", { path: "drafts/from-root.md" }, 5500);
  });

  afterEach(() => {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("proposes moves by the folder's name and by who wrote each file, and lists the rest", () => {
    const plan = planTidy(kernel.workspace);
    expect(plan.moves.map((m) => [m.from, m.to, m.why]).sort()).toEqual([
      ["drafts/cover-letter.md", "projects/resume/drafts/cover-letter.md", "written"],
      ["school/bu252/mokable/doc.md", "projects/school/bu252/mokable/doc.md", "named"],
      ["school/bu354/review.md", "projects/school/bu354/review.md", "named"],
    ]);
    expect(plan.unknown.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: "drafts/ambiguous.md", why: "written while several chats ran" },
      { path: "drafts/from-root.md", why: 'written by the root chat "Loose"' },
      { path: "notes/unknown.md", why: "no record of what wrote it" },
    ]);
    expect(describeTidy(plan)).toContain("Into projects/school/:\n  school/bu252/mokable/doc.md -> projects/school/bu252/mokable/doc.md");
  });

  it("moves nothing while planning", () => {
    planTidy(kernel.workspace);
    expect(existsSync(join(root, "school", "bu354", "review.md"))).toBe(true);
    expect(existsSync(join(root, "projects", "school", "bu354"))).toBe(false);
  });

  it("merges folders, renames a clash instead of overwriting, and clears the folders it emptied", () => {
    const done = applyTidy(kernel.workspace, planTidy(kernel.workspace));
    expect(done.moved.map((m) => m.to).sort()).toEqual([
      "projects/resume/drafts/cover-letter.md",
      "projects/school/bu252/mokable/doc copy.md",
      "projects/school/bu354/review.md",
    ]);
    expect(readFileSync(join(root, "projects", "school", "bu252", "mokable", "doc.md"), "utf8")).toBe("already here, different");
    expect(readFileSync(join(root, "projects", "school", "bu252", "mokable", "doc copy.md"), "utf8")).toBe("school/bu252/mokable/doc.md");
    expect(existsSync(join(root, "school"))).toBe(false);
    // drafts/ still holds what nobody could place.
    expect(existsSync(join(root, "drafts", "ambiguous.md"))).toBe(true);
    expect(existsSync(join(root, "drafts", "cover-letter.md"))).toBe(false);
  });

  it("leaves a file whose twin is already in place, and one gone since the plan", () => {
    put("projects/school/bu354/review.md", "school/bu354/review.md");
    const plan = planTidy(kernel.workspace);
    rmSync(join(root, "drafts", "cover-letter.md"));
    const done = applyTidy(kernel.workspace, plan);
    expect(done.skipped).toEqual([
      { from: "drafts/cover-letter.md", why: "no longer there" },
      { from: "school/bu354/review.md", why: "the same file is already at projects/school/bu354/review.md" },
    ]);
    expect(existsSync(join(root, "school", "bu354", "review.md"))).toBe(true);
  });

  it("reads where a write landed from its result, once a turn's home placed it", () => {
    put("drafts/placed.md");
    ran("chat", kernel.conversations.list(kernel.profile.ownerId).find((c) => c.projectSlug === "school")!.id, 7000, 8000);
    // The school chat wrote drafts/placed.md inside its own folder; the root file of that name is not its.
    audit("files.write", { path: "drafts/placed.md" }, 7500, "wrote projects/school/drafts/placed.md");
    expect(planTidy(kernel.workspace).unknown.map((u) => u.path)).toContain("drafts/placed.md");
  });
});
