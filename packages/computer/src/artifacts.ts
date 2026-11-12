import { ARTIFACT_ID_RE } from "@kos/shared";

import type { PanelPlaceOf } from "./panel.js";

/**
 * The owner's artifacts, read on a device that has no dashboard: KOS for
 * iPhone. It lists the ones the owner could open on the dashboard, opens one
 * as the dashboard's frame draws it (the same wrapper, policy, guard, bridge,
 * tokens, kit, fonts and runtime, built by the server, an older version's
 * read-only look), and answers the reads its window.kos makes, decided as the
 * dashboard's are. Nothing here writes: a phone looks at its artifacts.
 */

/** An artifact a device may open, as the dashboard's gallery lists it. */
export interface PanelArtifact {
  id: string;
  title: string;
  kind: string;
  description?: string;
  updatedAt: number;
  place?: PanelPlaceOf;
}

/** One drawn for a device: its whole frame in one theme, and each theme's tokens to switch to as a rule. */
export interface PanelArtifactView extends PanelArtifact {
  document: string;
  themes: { light: string; dark: string };
}

export type ArtifactTheme = "light" | "dark";

/** What the host gives a panel to read artifacts with. */
export interface PanelArtifacts {
  /** The owner's artifacts the dashboard opens, the latest changed first. */
  recent(): PanelArtifact[];
  /** One drawn read-only, or undefined when there is none the owner can open on a device; throws, in words, when it cannot be drawn. */
  open(id: string, theme: ArtifactTheme): PanelArtifactView | undefined;
  /** A read its window.kos makes, a query of its project's tables or one of its project's files, decided as the dashboard's are. */
  read(id: string, method: "query" | "file", args: Record<string, unknown>): Promise<unknown>;
}

/** How many a device is sent to choose from. */
export const ARTIFACTS_LISTED = 30;
/** The largest frame a device is sent: a phone's line takes 16 MB, and an artifact is rarely a tenth of this. */
export const ARTIFACT_DOCUMENT_BYTES = 8 * 1024 * 1024;
const ID_MAX = 120;

/** Each device's open artifact, the only one whose reads it may ask. */
export class ArtifactReader {
  private readonly opened = new Map<string, string>();

  constructor(private readonly artifacts: PanelArtifacts) {}

  /** What `chat.artifacts` carries. */
  list(): Record<string, unknown> {
    return { artifacts: this.artifacts.recent().slice(0, ARTIFACTS_LISTED) };
  }

  /** What `chat.artifact` carries for the device's ask: the artifact drawn, or why not, with the id it asked for. */
  open(device: string, data: Record<string, unknown>): Record<string, unknown> {
    const id = data["id"];
    if (typeof id !== "string" || id.length > ID_MAX || !ARTIFACT_ID_RE.test(id)) return { id: typeof id === "string" ? id.slice(0, ID_MAX) : null, error: "That is not an artifact's id." };
    const theme: ArtifactTheme = data["theme"] === "dark" ? "dark" : "light";
    let view: PanelArtifactView | undefined;
    try {
      view = this.artifacts.open(id, theme);
    } catch (err) {
      return { id, error: err instanceof Error ? err.message : String(err) };
    }
    if (!view) return { id, error: "There is no artifact by that id that opens here." };
    if (Buffer.byteLength(view.document, "utf8") > ARTIFACT_DOCUMENT_BYTES) return { id, error: "That artifact is too big to show on a phone. Open it on the dashboard." };
    this.opened.set(device, id);
    return { ...view, theme };
  }

  /** What `chat.read` carries for one read the device's open artifact asked, or undefined for an ask that is not one. */
  async read(device: string, data: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    const { artifact, call, method, args } = data;
    if (typeof artifact !== "string" || typeof call !== "number" || !Number.isInteger(call)) return undefined;
    const answer = (body: { result: unknown } | { error: string }): Record<string, unknown> => ({ artifact, call, ...body });
    if (this.opened.get(device) !== artifact) return answer({ error: "That artifact is not open here." });
    if (method !== "query" && method !== "file") return answer({ error: "A phone only reads an artifact." });
    const given = typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
    try {
      return answer({ result: await this.artifacts.read(artifact, method, given) });
    } catch (err) {
      return answer({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** A device gone: what it had open goes with it. */
  forget(device: string): void {
    this.opened.delete(device);
  }
}
