// Grading what KOS made: the artifact as stored (its kind, owner, structure), what artifacts.check
// reports when the grader runs it on the final version, and a model that looks at the four
// captures with a fixed rubric taken from KOS's own guide. The captures are copied into the run's
// folder, which outlives its workspace, so the best of each kind can be kept.

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The rubric, from the guide's principles, the same for every kind but its last point. */
const RUBRIC = {
  common: [
    "1. It looks finished and specific to its subject: real content in the subject's own terms and units, no placeholder text, no lorem ipsum, nothing that reads as a template.",
    "2. Clear hierarchy: a visible title, a deliberate type scale, readable body text, consistent edges, spacing and alignment across repeated elements.",
    "3. Both themes are designed: the dark pictures are a real dark design with readable text and the light ones a real light design; neither looks broken, washed out or simply inverted.",
    "4. Nothing overlaps, is clipped or runs off the side at phone width; the phone layout is a real one-column layout, not a shrunken desktop.",
    "5. It avoids the generated look: no purple-to-blue gradient hero, no emoji as section markers, not everything centred, not rounded cards around everything, no numbered 01/02/03 markers on things that are not a sequence.",
  ],
  page: "6. As a dashboard: a summary before detail, figures with their units, charts drawn to scale with readable labels, in a working state with the data shown.",
  doc: "6. As a document: a lede that states the point, sections with plain headings, comfortable line length, tables or figures where they help; it reads like a designed brief, not a web page.",
  deck: "6. As slides: a 16:9 slide that is legible at a glance, one idea per slide, large type, a clear title; visuals or a few words rather than walls of bullets.",
  sheet: "6. As a spreadsheet: a grid with typed, right-aligned numbers in a consistent format, readable headers, totals, and a short title with context. On a phone a grid wider than the screen scrolls sideways inside its own box, its key figure held at the right edge and the tools saying how many more columns there are; that is by design, not running off the side, as long as the page itself does not.",
};

/** The artifact a run made: the newest written since it started, of the kind asked for if there is one. */
export function madeArtifact(ctx, kind) {
  const rows = ctx.sql(`select id, project_slug, title, path, kind, meta, updated_at from pages where updated_at >= ${ctx.t0} order by updated_at desc`);
  const parsed = rows.map((r) => ({ ...r, meta: r.meta ? JSON.parse(r.meta) : {} })).map((r) => ({ ...r, artifactKind: r.meta.kind ?? "page" }));
  return parsed.find((r) => r.artifactKind === kind) ?? parsed[0];
}

/** Checkpoints shared by every artifact task, and what the task's own checks need. */
export async function gradeArtifact(ctx, { kind, project }) {
  const out = [];
  const a = madeArtifact(ctx, kind);
  out.push(ctx.check(`an artifact of kind ${kind} was written`, a?.artifactKind === kind, a ? `${a.id}: ${a.artifactKind} "${a.title}"` : "none"));
  if (!a) return { out };
  if (project !== undefined) out.push(ctx.check(project ? "it belongs to the project" : "it is a workspace artifact", (a.project_slug || null) === (project || null), a.project_slug || "workspace"));
  out.push(ctx.check("it has a short title and a one-sentence description", a.title.length <= 60 && typeof a.meta.description === "string" && a.meta.description.length > 10, `"${a.title}"; ${a.meta.description ? `"${a.meta.description.slice(0, 120)}"` : "no description"}`));
  const tools = ctx.tools.map((t) => t.tool);
  out.push(ctx.check("it read the guide and checked its work once or twice", tools.includes("artifacts.guide") && tools.includes("artifacts.check") && tools.filter((t) => t === "artifacts.check").length <= 2, `guide ${tools.filter((t) => t === "artifacts.guide").length}, check ${tools.filter((t) => t === "artifacts.check").length}`));
  const html = ctx.readFile(a.path) ?? "";

  // artifacts.check on the version that stands, as the grader sees it.
  const report = await ctx.kos.api(`/api/artifacts/${encodeURIComponent(a.id)}/check`, {}, 120_000);
  const findings = Array.isArray(report.findings) ? report.findings : [];
  const serious = findings.filter((f) => ["overflow", "console", "bridge", "title", "formula", "left"].includes(f.kind));
  out.push(ctx.check("artifacts.check finds nothing serious (overflow, errors, failed calls, no title)", !report.error && serious.length === 0, report.error ?? (serious.map((f) => f.text).join(" | ").slice(0, 380) || "none")));
  out.push(ctx.check("artifacts.check finds at most two small things", !report.error && findings.length <= 2, report.error ?? `${findings.length}: ${findings.map((f) => `[${f.kind}] ${f.text}`).join(" | ").slice(0, 360)}`));

  // The captures the check just made, kept, and looked at.
  const folder = a.project_slug ? join("projects", a.project_slug, "pages") : "artifacts";
  const from = join(ctx.host.workspace, folder, ".captures", a.id);
  const keep = join(ctx.dir, "captures");
  mkdirSync(keep, { recursive: true });
  const pictures = [];
  for (const k of ["desktop-light", "desktop-dark", "phone-light", "phone-dark"]) {
    const file = join(from, `${k}.jpg`);
    if (!existsSync(file)) continue;
    copyFileSync(file, join(keep, `${k}.jpg`));
    pictures.push({ label: `${k.replace("-", ", ")} (${k.startsWith("desktop") ? "1280" : "390"} px wide)`, data: readFileSync(file).toString("base64") });
  }
  const verdict = pictures.length ? await ctx.look([...RUBRIC.common, RUBRIC[kind]].join("\n"), pictures) : { pass: false, score: 0, reason: "no captures", model: "-" };
  out.push(ctx.check(`it looks good, light and dark, desktop and phone (judge, ${verdict.score}/5)`, verdict.pass, `${verdict.model}: ${verdict.reason}`, { judge: true, look: verdict.score }));
  return { out, artifact: a, html, findings };
}
