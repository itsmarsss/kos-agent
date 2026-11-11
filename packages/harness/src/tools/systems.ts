import type { KosModule, ModuleContext } from "../modules/loader.js";
import { requireServices } from "../modules/loader.js";
import { migrationEscalation } from "../risk/rules.js";
import { parseChangeSpec } from "../systems/migrate.js";
import { deleteProject } from "../systems/remove.js";
import type { CreateProjectInput } from "../systems/manifest.js";
import { artifactGuide } from "../systems/artifactguide.js";
import { PATCH_EDITS_MAX, patchEdits, patchSummary } from "../systems/artifactpatch.js";
import { ARTIFACT_KINDS, WORKSPACE_SCOPE, isArtifactKind } from "@kos/shared";
import { maintains, reachable, type Reach } from "./fence.js";
import { reachOf } from "./sql.js";
import { ownerOfRecord, type PageOwner, type PageStore } from "../systems/pages.js";

/**
 * Systems tools: project creation, guarded migrate, and artifacts. These are
 * the primitives the agent uses to build structured projects instead of
 * inventing raw DDL; an artifact is HTML it writes, reaching data only
 * through window.kos.
 */

/**
 * The write tool's description: what it takes, and where the guide is. The
 * guide itself (artifactguide.ts) is long and read on demand, so it is not
 * in every prompt. Where KOS has no Chrome there is no check to ask for, and
 * the model is told so rather than sent to a tool that cannot run.
 */
function writeDescription(canCheck: boolean): string {
  return [
    "Save an artifact: one self-contained HTML document of a kind (page: an app, dashboard or tool; doc: a designed document; deck: slides; sheet: a spreadsheet). It shows on the dashboard in a sandboxed frame with no network, reaching data only through window.kos, and every save keeps the old one as a version (artifacts.history, artifacts.rollback).",
    canCheck
      ? "Read artifacts.guide({ kind }) first, every time: it says how KOS artifacts are designed, the structure each kind's runtime reads, the fonts, and what the frame refuses. Then write, check once with artifacts.check, fix what it reports in one pass, and finish."
      : "Read artifacts.guide({ kind }) first, every time: it says how KOS artifacts are designed, the structure each kind's runtime reads, the fonts, and what the frame refuses. This KOS has no Chrome, so artifacts.check is not available: write once, carefully, and finish.",
    `project is the project whose data it shows. Omit it for a new workspace artifact that belongs to no project (a memo, a deck from notes); it then has no tables or files to read. In a blob's own thread, an artifact written without project is the blob's own, kept with its files, and like a workspace one it reads no tables. Rewriting an existing id without project keeps it where it is; name a project, or "${WORKSPACE_SCOPE}", only to move it. If a project fits but does not exist, call systems.project_create first; never file an artifact under an unrelated project because it exists.`,
    "title is a short specific name, not a caption; description is one sentence saying what it is for.",
  ].join("\n");
}

/**
 * The patch tool's description: when to patch rather than write, with an
 * example. A patch is checked as it is saved, so there is no check to ask for
 * after it.
 */
function patchDescription(canCheck: boolean): string {
  return [
    "Change part of an artifact and leave the rest as it is: a title, a sentence, a row, a colour, one section. Prefer it to artifacts.write for any targeted change; write the whole document only for a redesign or a new structure.",
    'Read it first with artifacts.get, then give edits against that stored HTML. Each { find, replace } needs a find copied exactly from the HTML (whitespace and entities included) that occurs exactly once: make it long enough to be unique, or set all: true to change every occurrence. { id, html } replaces the one element with that id, whole. Edits apply in order and all or none: if one fails, nothing changes, and the error says which and why. Example: { "id": "q4", "edits": [{ "find": "<h1>Q3 review</h1>", "replace": "<h1>Q4 review</h1>" }, { "find": "<td>Rent</td><td>1,800</td>", "replace": "<td>Rent</td><td>1,950</td>" }] }',
    canCheck
      ? "The result is held to every check artifacts.write holds, kept as a version, and then checked as artifacts.check does; it returns the new version, what changed, and the check's findings. Fix what they report with one more patch, and finish."
      : "The result is held to every check artifacts.write holds and kept as a version; it returns the new version and what changed.",
  ].join("\n");
}

function str(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== "string" || v === "") throw new Error(`missing arg: ${key}`);
  return v;
}

/**
 * A project's schema is changed by the chats that may fill it, under the
 * sql fence's rule: its own chats, the turn that made it, and Maintenance.
 * Anywhere else could make a table it was then refused the rows of.
 */
function refuseOutsideReach(project: string, reach: Reach): void {
  if (maintains(reach) || reachable(reach).includes(project)) return;
  const name = reach.projects.find((p) => p.slug === project)?.name ?? project;
  const here = reach.project ? `This chat is ${reach.projects.find((p) => p.slug === reach.project)?.name ?? reach.project}'s` : "This chat belongs to no project";
  throw new Error(`${here}, so ${name}'s tables are not its to change. Hand the work to ${name}'s own chat with chats.handoff to @project:${project}, saying what to build and load.`);
}

/** The artifact tools: a project's orchestrator is granted them for its own project's artifacts. */
export const ARTIFACT_TOOLS = [
  "artifacts.write",
  "artifacts.patch",
  "artifacts.list",
  "artifacts.get",
  "artifacts.history",
  "artifacts.rollback",
  "artifacts.rename",
  "artifacts.duplicate",
  "artifacts.move",
  "artifacts.guide",
  "artifacts.check",
] as const;

/**
 * Whose artifacts a chat may read and change. A project's are its own chats',
 * as its tables are: those chats, the turn that made the project, and
 * Maintenance. A blob's are its own thread's, as its folder is its own: no
 * project's chat reaches them, nor another blob's, while the owner's own
 * chats at the root and Maintenance reach them as they reach a blob's files.
 * A blob is told apart by its id, so a blob made under a removed one's name
 * reaches none of what the removed one made, and what a removed blob made is
 * kept for the owner: KOS reads it but no longer changes it. A blob's thread
 * reaches its own and the workspace's, never a project's. The workspace's
 * belong to no one, so to any chat.
 */
export function whyNot(owner: PageOwner, reach: Reach, what: "change" | "read", removed: (blobId: string) => boolean): string | undefined {
  if (owner === null) return undefined;
  if (typeof owner === "object" && what === "change" && removed(owner.id)) {
    return `The blob ${owner.blob} that made it was removed, so what it made is kept for the owner as it is: its artifacts`;
  }
  if (maintains(reach)) return undefined;
  const name = (slug: string): string => reach.projects.find((p) => p.slug === slug)?.name ?? slug;
  const here = reach.project ? `This chat is ${name(reach.project)}'s` : reach.blob ? `This chat is the blob ${reach.blob.name}'s` : undefined;
  if (typeof owner === "string") {
    if (!reach.blob && reachable(reach).includes(owner)) return undefined;
    return `${here ?? "This chat belongs to no project"}, so ${name(owner)}'s artifacts`;
  }
  // A blob's: its own thread, and the owner's own chats at the root, which reach blob files too.
  if (reach.blob?.id === owner.id || (!reach.project && !reach.blob && reach.owner)) return undefined;
  return `${here ?? "This chat"}, so the blob ${owner.blob}'s artifacts`;
}

const handTo = (owner: PageOwner, reach: Reach, removed: (blobId: string) => boolean): string =>
  typeof owner === "string"
    ? ` Hand the work to ${reach.projects.find((p) => p.slug === owner)?.name ?? owner}'s own chat with chats.handoff to @project:${owner}.`
    : owner && !removed(owner.id)
      ? ` Ask the blob with blobs.dispatch to ${owner.blob}.`
      : "";

/** What a change to a trashed artifact is told, by any road: it waits for the owner. */
const IN_TRASH = "which the owner put in the trash: it is left as it is until they restore it from the Artifacts page's Trash";

/**
 * Why a chat may not reach the artifact a workspace path is part of (its
 * file, a version or a capture), or undefined when it may or the path is no
 * artifact's: files.* and an @file mention keep the same fence as the
 * artifacts tools, rather than being a way round it.
 */
export function artifactFileRefusal(pages: PageStore, path: string, reach: Reach, what: "change" | "read"): string | undefined {
  const record = pages.recordAt(path);
  if (!record) return undefined;
  if (what === "change" && record.trashedAt !== undefined) return `${path} is part of the artifact ${record.id}, ${IN_TRASH}`;
  const owner = ownerOfRecord(record);
  const removed = (blobId: string): boolean => pages.blobIds.removed(blobId);
  const why = whyNot(owner, reach, what, removed);
  return why ? `${path} is part of the artifact ${record.id}; ${why} are not this chat's to ${what}.${handTo(owner, reach, removed)}` : undefined;
}

/**
 * Why a chat may not take a whole folder (rm, mv, cp): the first artifact
 * under it, by its rows, whose owner the chat may not reach. Undefined when
 * it may reach every one, or none is there.
 */
export function artifactFolderRefusal(pages: PageStore, folder: string, reach: Reach, what: "change" | "read"): string | undefined {
  const removed = (blobId: string): boolean => pages.blobIds.removed(blobId);
  for (const record of pages.recordsUnder(folder)) {
    if (what === "change" && record.trashedAt !== undefined) return `${folder} holds the artifact ${record.id}, ${IN_TRASH}`;
    const owner = ownerOfRecord(record);
    const why = whyNot(owner, reach, what, removed);
    if (why) return `${folder} holds the artifact ${record.id}; ${why} are not this chat's to ${what}.${handTo(owner, reach, removed)}`;
  }
  return undefined;
}

/** Who a new artifact from this chat belongs to when it names none: a blob's thread makes its own; anywhere else, the workspace. */
const defaultOwner = (reach: Reach): PageOwner => (reach.blob && !reach.project ? { blob: reach.blob.name, id: reach.blob.id } : null);

function defineSystemsTools(ctx: ModuleContext): void {
  const services = requireServices(ctx);
  const { manifest, migrator, pages, checkArtifact } = services;
  if (!manifest || !migrator || !pages) {
    throw new Error("systems module requires manifest, migrator, and pages services");
  }
  const removed = (blobId: string): boolean => pages.blobIds.removed(blobId);
  const refuseOtherOwnersPage = (owner: PageOwner, reach: Reach, what: "change" | "read" = "change"): void => {
    const why = whyNot(owner, reach, what, removed);
    if (why) throw new Error(`${why} are not its to ${what}.${handTo(owner, reach, removed)}`);
  };

  ctx.registerTool(
    {
      name: "systems.project_create",
      description:
        "Create a project in the manifest. Returns the project (name, slug, type, status). Use systems.migrate next to add tables.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          type: { type: "string", description: "e.g. tracker, notes, budget" },
          description: { type: "string" },
          module: {
            type: "string",
            description: "Optional module blueprint this is an instance of",
          },
          instancing: { type: "string", enum: ["single", "multi"] },
        },
        required: ["name", "type"],
      },
    },
    (input) => {
      const body: CreateProjectInput = {
        name: str(input, "name"),
        type: str(input, "type"),
      };
      if (typeof input.description === "string") body.description = input.description;
      if (typeof input.module === "string") body.module = input.module;
      if (input.instancing === "single" || input.instancing === "multi") {
        body.instancing = input.instancing;
      }
      const madeIn = ctx.services?.callerConversation?.();
      if (madeIn) body.madeIn = madeIn;
      const project = manifest.createProject(body);
      // The turn that makes a project may build it, its tables and its rows,
      // until the turn ends; made_in is only the record of where.
      ctx.services?.turnMade?.note(project.slug);
      return JSON.stringify(project);
    },
    { floor: "safe" },
    { tags: ["systems"] },
  );

  ctx.registerTool(
    {
      name: "systems.project_delete",
      description:
        "Permanently delete a project: drop its tables, delete its pages and files, and remove it from the manifest. This destroys the project's data and cannot be undone. To set a project aside reversibly instead, leave it and change its status to archived. Owner approval is required.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string", description: "project slug" },
        },
        required: ["project"],
      },
    },
    (input) => {
      const slug = str(input, "project");
      return JSON.stringify(deleteProject({ manifest, migrator, pages }, slug));
    },
    { floor: "risky", why: "deletes the project and its tables for good" },
    { tags: ["systems"] },
  );

  ctx.registerTool(
    {
      name: "systems.project_list",
      description: "List projects from the manifest.",
      inputSchema: {
        type: "object",
        properties: {
          module: { type: "string" },
        },
      },
    },
    (input) => {
      if (typeof input.module === "string" && input.module) {
        return JSON.stringify(manifest.listByModule(input.module));
      }
      return JSON.stringify(manifest.list());
    },
    { floor: "safe" },
    { tags: ["systems"] },
  );

  ctx.registerTool(
    {
      name: "systems.migrate",
      description:
        "Apply a guarded schema change to a project. This is SQLite. Tables are namespaced to the project slug automatically. Additive ops (create_table, add_column, create_index) apply immediately; drop_column, rename_column, and rename_table need owner approval. Never use raw DDL via sql.\n" +
        "spec shapes, by op:\n" +
        '  create_table: {op, table, columns: [{name, type, primaryKey?, notNull?, unique?, default?}]}\n' +
        '  add_column:   {op, table, column: {name, type, ...}}\n' +
        '  drop_column:  {op, table, column: "name"}\n' +
        '  rename_column:{op, table, from, to}\n' +
        '  rename_table: {op, from, to}\n' +
        '  create_index: {op, table, columns: ["a","b"], unique?, name?}\n' +
        "A column type must be one of TEXT, INTEGER, REAL, BLOB, NUMERIC. There is no serial, decimal, date, or varchar: use INTEGER with primaryKey for a row id, REAL for money, and TEXT holding ISO-8601 for a date.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string", description: "project slug" },
          spec: {
            type: "object",
            description:
              'changeSpec, e.g. {"op":"create_table","table":"expenses","columns":[{"name":"id","type":"INTEGER","primaryKey":true},{"name":"spent_on","type":"TEXT"},{"name":"amount","type":"REAL"}]}',
          },
        },
        required: ["project", "spec"],
      },
    },
    (input) => {
      const project = str(input, "project");
      // Checked rather than cast: this arrives as free-form model JSON, and a
      // wrong guess has to come back as an instruction, not a TypeError.
      const spec = parseChangeSpec(input.spec);
      refuseOutsideReach(project, reachOf(ctx));
      const record = migrator.migrate(project, spec);
      return JSON.stringify({
        id: record.id,
        version: record.version,
        op: record.op,
        sql: record.sql,
      });
    },
    // Risk is tool plus arguments: additive schema changes are safe, and
    // destructive or unclassifiable ones escalate to the approval queue.
    { floor: "safe", escalate: (input) => (migrationEscalation(input) ? "a schema change that is not an add" : false) },
    { tags: ["systems"] },
  );

  ctx.registerTool(
    {
      name: "artifacts.guide",
      description: "KOS's design guide for artifacts: how to decide the treatment, plan tokens for both themes, set type, lay out, and write copy, plus the structure the kind's runtime reads and the fonts KOS bundles. Read it before every artifacts.write.",
      inputSchema: {
        type: "object",
        properties: { kind: { type: "string", enum: [...ARTIFACT_KINDS], description: "the kind about to be written: page, doc, deck or sheet" } },
      },
    },
    (input) => artifactGuide(isArtifactKind(input.kind) ? input.kind : undefined, checkArtifact !== undefined),
    { floor: "safe" },
    { tags: ["systems"] },
  );

  ctx.registerTool(
    {
      name: "artifacts.write",
      description: writeDescription(checkArtifact !== undefined),
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string", description: `project slug whose data it shows; omit for a new workspace artifact, or to keep an existing one where it is; "${WORKSPACE_SCOPE}" moves one to the workspace` },
          id: { type: "string", description: "letters, digits, _ or -; writing an existing id replaces it and keeps the old one as a version" },
          kind: { type: "string", enum: [...ARTIFACT_KINDS], description: "page (default), doc, deck or sheet" },
          title: { type: "string", description: "a short specific name" },
          description: { type: "string", description: "one sentence: what it is for" },
          html: { type: "string", description: "the whole document, in the kind's structure (artifacts.guide)" },
          fonts: { type: "array", items: { type: "string" }, description: "bundled font ids (artifacts.guide lists them); the kind's defaults when omitted" },
          capabilities: {
            type: "object",
            description: "what it may reach through window.kos",
            properties: {
              query: { type: "boolean", description: "read-only queries of this project's tables; on unless false" },
              writes: {
                type: "array",
                description: "tables it may change: each { table, columns, allow? } with the PHYSICAL table name; allow is any of insert, update, delete (default insert, update)",
                items: { type: "object" },
              },
              files: { type: "boolean", description: "read text files inside the project's folder" },
              ask: { type: "boolean", description: "offer a message to the project's chat; the owner confirms each one" },
            },
          },
          libraries: { type: "array", items: { type: "string", enum: ["react", "charts"] } },
          headline: { type: "object", description: "the figure for the project's card on Home: { label, query } with a single read-only SELECT returning one value" },
          spec: { type: "object", description: "the older JSON widget spec, kept for pages written that way; prefer html" },
        },
        required: ["id", "title"],
      },
    },
    (input) => {
      const reach = reachOf(ctx);
      // Ids are shared across projects, and a write upserts by id: the artifact it would replace is checked too,
      // or one project could take another's by naming it as its own.
      // One id names one artifact: a spec whose own id differs would be written under that one, past this check.
      const spec = input.spec as { id?: unknown } | undefined;
      const specId = typeof spec?.id === "string" ? spec.id : undefined;
      const inputId = typeof input.id === "string" ? input.id : undefined;
      if (specId !== undefined && inputId !== undefined && specId !== inputId) throw new Error(`id "${inputId}" and spec.id "${specId}" differ; an artifact has one id, so give both the same`);
      const id = inputId ?? specId;
      const replaced = id ? pages.record(id) : undefined;
      if (replaced) refuseOtherOwnersPage(ownerOfRecord(replaced), reach);
      // A rewrite stays where it is unless told to move: a model leaves project out when it means "the same one".
      const named = typeof input.project === "string" && input.project !== "" ? input.project : input.project === null ? WORKSPACE_SCOPE : undefined;
      const owner: PageOwner = named === undefined ? (replaced ? ownerOfRecord(replaced) : defaultOwner(reach)) : named === WORKSPACE_SCOPE ? null : named;
      refuseOtherOwnersPage(owner, reach);
      // The store holds the line too: it replaces only the row this check passed, and moves it only from there.
      const from = replaced ? { from: ownerOfRecord(replaced) } : {};
      if (input.spec !== undefined && input.html === undefined) {
        if (typeof owner !== "string") throw new Error("a widget spec page needs a project; write html instead");
        return JSON.stringify(pages.write(owner, input.spec, from));
      }
      const { project: _project, spec: _spec, ...page } = input;
      const record = pages.writeHtml(owner, page, from);
      return JSON.stringify({ ...record, next: checkArtifact ? `Check it once: artifacts.check({ id: "${record.id}" }).` : undefined });
    },
    { floor: "safe" },
    { tags: ["systems"] },
  );

  ctx.registerTool(
    {
      name: "artifacts.check",
      description: !checkArtifact
        ? "Not available on this KOS: it has no Chrome to render artifacts in. Do not call it; write to artifacts.guide and finish."
        : "Render an artifact in KOS's own headless Chrome at desktop (1280 px) and phone (390 px) widths, light and dark, and report what is wrong: sideways overflow and the element causing it, text cut off by a box that hides its overflow, text drawn over other text, colours that stay the same in both themes, text below AA contrast, console errors, failed window.kos calls, regions empty at rest, formula errors, a missing visible title; with small screenshots. Check once after writing, fix everything it reports in one pass, write again, and finish: no check loops.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
    async (input) => {
      if (!checkArtifact) throw new Error("this KOS cannot check artifacts: it has no Chrome to render them in");
      const id = str(input, "id");
      const record = pages.record(id);
      if (record) refuseOtherOwnersPage(ownerOfRecord(record), reachOf(ctx), "read");
      if (record?.trashedAt !== undefined) throw new Error(`the artifact ${id} is in the trash, left as it is until the owner restores it; there is nothing to check`);
      return checkArtifact(id);
    },
    { floor: "safe" },
    { tags: ["systems"] },
  );

  ctx.registerTool(
    {
      name: "artifacts.list",
      description: `List artifacts: every one, one project's, or the workspace's own (project: "${WORKSPACE_SCOPE}"), each with its kind (page, doc, deck, sheet), title and description. What the owner put in the trash is left out; trashed: true lists only that, which stays as it is until the owner restores it.`,
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          trashed: { type: "boolean", description: "list what is in the trash instead" },
        },
      },
    },
    (input) => {
      const project = typeof input.project === "string" && input.project ? input.project : undefined;
      const reach = reachOf(ctx);
      // Only what this chat may read: a blob's from a project's chat or another blob's is left out, and a blob's turn sees its own and the workspace's.
      return JSON.stringify(pages.list(project === WORKSPACE_SCOPE ? null : project, { trashed: input.trashed === true }).filter((r) => (r.blob === undefined && !reach.blob) || whyNot(ownerOfRecord(r), reach, "read", removed) === undefined));
    },
    { floor: "safe" },
    { tags: ["systems"] },
  );

  ctx.registerTool(
    {
      name: "artifacts.get",
      description: "Load one artifact by id: its HTML with its kind and declarations, or an older widget spec. Read one before changing it.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
        },
        required: ["id"],
      },
    },
    (input) => {
      const got = pages.get(str(input, "id"));
      if (!got) throw new Error(`artifact not found: ${input.id}`);
      refuseOtherOwnersPage(ownerOfRecord(got.record), reachOf(ctx), "read");
      return JSON.stringify(got.kind === "html" ? { record: got.record, page: got.page } : { record: got.record, spec: got.spec });
    },
    { floor: "safe" },
    { tags: ["systems"] },
  );

  ctx.registerTool(
    {
      name: "artifacts.history",
      description: "List the kept versions of an artifact, oldest first; the last is what shows now. The owner's own edits to a doc or sheet are versions too.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
    (input) => {
      const id = str(input, "id");
      const record = pages.record(id);
      if (record) refuseOtherOwnersPage(ownerOfRecord(record), reachOf(ctx), "read");
      return JSON.stringify(pages.history(id));
    },
    { floor: "safe" },
    { tags: ["systems"] },
  );

  ctx.registerTool(
    {
      name: "artifacts.rollback",
      description: "Put an artifact back as it was at one of its versions (artifacts.history). The rollback is itself kept as a version, so it can be undone.",
      inputSchema: { type: "object", properties: { id: { type: "string" }, version: { type: "number" } }, required: ["id", "version"] },
    },
    (input) => {
      const id = str(input, "id");
      const record = pages.record(id);
      if (record) refuseOtherOwnersPage(ownerOfRecord(record), reachOf(ctx));
      return JSON.stringify(pages.rollback(id, Number(input.version)));
    },
    { floor: "safe" },
    { tags: ["systems"] },
  );

  /**
   * The artifact a management call names, held to who may change it. A
   * guest's turn is offered none of these tools (GUEST_TOOLS); work a guest's
   * words started and that was handed on to a chat that has them is refused
   * here, wherever it ran.
   */
  const changeable = (input: Record<string, unknown>, reach: Reach): string => {
    if (reach.guest) throw new Error("a guest's words started this work, and artifacts are the owner's and KOS's to change; tell the owner (notify) what was asked");
    const id = str(input, "id");
    const record = pages.record(id);
    if (!record) throw new Error(`artifact not found: ${id}`);
    refuseOtherOwnersPage(ownerOfRecord(record), reach);
    return id;
  };

  ctx.registerTool(
    {
      name: "artifacts.patch",
      description: patchDescription(checkArtifact !== undefined),
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          edits: {
            type: "array",
            description: `applied in order, all or none, at most ${PATCH_EDITS_MAX}: { find, replace } (find occurs exactly once), { find, replace, all: true } (every occurrence), or { id, html } (the element with that id, replaced whole)`,
            items: {
              type: "object",
              properties: {
                find: { type: "string", description: "an exact piece of the stored HTML, as artifacts.get returns it" },
                replace: { type: "string" },
                all: { type: "boolean", description: "replace every occurrence of find, not just one" },
                id: { type: "string", description: "the id of one element to replace whole" },
                html: { type: "string", description: "the element's new outerHTML" },
              },
            },
          },
        },
        required: ["id", "edits"],
      },
    },
    async (input) => {
      const id = changeable(input, reachOf(ctx));
      const edits = patchEdits(input.edits);
      const { record, before, after, replaced } = pages.patch(id, edits);
      const summary = JSON.stringify({ id: record.id, title: record.title, version: pages.latestVersion(id), edits: edits.length, replaced, ...patchSummary(before, after) });
      if (!checkArtifact) return summary;
      // The patch is kept whatever the check finds; a check that cannot run says so rather than failing what was saved.
      const checked = await checkArtifact(id).catch((err: unknown) => ({ text: `Saved, but the check could not run: ${err instanceof Error ? err.message : String(err)}` }));
      return { ...checked, text: `${summary}\n\n${checked.text}` };
    },
    { floor: "safe" },
    { tags: ["systems"] },
  );

  ctx.registerTool(
    {
      name: "artifacts.rename",
      description: "Give an artifact a new title, a new description, or both. Its id stays, so every mention and link to it still finds it, and the rename is kept as a version.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string", description: "a short specific name" },
          description: { type: "string", description: "one sentence: what it is for" },
        },
        required: ["id"],
      },
    },
    (input) => {
      const id = changeable(input, reachOf(ctx));
      return JSON.stringify(pages.rename(id, { ...(typeof input.title === "string" ? { title: input.title } : {}), ...(typeof input.description === "string" ? { description: input.description } : {}) }));
    },
    { floor: "safe" },
    { tags: ["systems"] },
  );

  ctx.registerTool(
    {
      name: "artifacts.duplicate",
      description: 'Copy an artifact beside itself, for the same owner, titled "<title> copy" under a new id (returned). The copy is an artifact of its own: its history starts with it.',
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
    (input) => JSON.stringify(pages.duplicate(changeable(input, reachOf(ctx)))),
    { floor: "safe" },
    { tags: ["systems"] },
  );

  ctx.registerTool(
    {
      name: "artifacts.move",
      description: `Give an artifact to another owner: a project (project: its slug), the workspace (project: "${WORKSPACE_SCOPE}"), or a blob (blob: its name). Its id, versions and captures go with it. Both ends must be this chat's to change: a project's chat moves its own artifacts and the workspace's, never into another project. An artifact that reads its project's tables cannot go where those tables are not.`,
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          project: { type: "string", description: `the project's slug, or "${WORKSPACE_SCOPE}"` },
          blob: { type: "string", description: "a living blob's name" },
        },
        required: ["id"],
      },
    },
    (input) => {
      const reach = reachOf(ctx);
      const id = changeable(input, reach);
      const to = pages.destination(input);
      refuseOtherOwnersPage(to, reach);
      return JSON.stringify(pages.move(id, to));
    },
    { floor: "safe" },
    { tags: ["systems"] },
  );
}

export const systemsModule: KosModule = {
  manifest: {
    name: "systems",
    version: "1.0.0",
    provides: [
      { kind: "tool", name: "systems.project_create", version: "1.0.0" },
      { kind: "tool", name: "systems.project_delete", version: "1.0.0" },
      { kind: "tool", name: "systems.project_list", version: "1.0.0" },
      { kind: "tool", name: "systems.migrate", version: "1.0.0" },
      ...ARTIFACT_TOOLS.map((name) => ({ kind: "tool" as const, name, version: "1.0.0" })),
    ],
    riskTier: "risky",
  },
  activate(ctx) {
    defineSystemsTools(ctx);
  },
};
