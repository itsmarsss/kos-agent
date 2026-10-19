import { officeKindOf, officeNote, officeText } from "../files/office.js";
import { pdfText } from "../files/pdftext.js";
import type { ContentBlock } from "../models/types.js";

/**
 * Files the owner attached to a message.
 *
 * Two kinds reach a model at all: an image, which travels as bytes, and text,
 * which is inlined with its filename so the model knows what it is looking at.
 * A PDF becomes the text it reads as before it gets that far. Anything else
 * is refused here rather than sent as something the provider will reject or,
 * worse, silently ignore.
 */

export interface Attachment {
  name: string;
  /** Media type as reported by the browser, e.g. "image/png". */
  mediaType: string;
  /** Base64 payload, without the data: prefix. */
  data: string;
}

/** A file kept from a message's attachments: what it was called, and where it now lives in the workspace. */
export interface KeptFile {
  name: string;
  /** Workspace-relative path. */
  path: string;
}

/** Bytes per attachment. Base64 inflates by a third, and prompts have limits. */
const MAX_BYTES = 5 * 1024 * 1024;

const TEXTUAL = /^(text\/|application\/(json|xml|x-yaml|yaml|toml|javascript|typescript|x-tex|x-latex|sql|x-sh|rtf))/;

/**
 * Extensions that are text whatever the browser claims. Browsers report an
 * empty or generic type for most of these: .tex came through as "unknown type"
 * and was refused, which is not a thing a reader can act on.
 */
const TEXT_EXTENSIONS =
  /\.(md|markdown|txt|text|csv|tsv|json|jsonl|ya?ml|toml|ini|cfg|conf|env|log|tex|bib|cls|sty|rst|org|adoc|ts|tsx|js|jsx|mjs|cjs|css|scss|less|html?|xml|svg|sql|sh|bash|zsh|fish|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|pl|lua|r|jl|vue|svelte|astro|gradle|dockerfile|makefile|gitignore|npmrc|lock)$/i;

export function isImage(mediaType: string): boolean {
  return mediaType.startsWith("image/");
}

/** A PDF, by type or by name: browsers and surfaces are not consistent about which they report. */
export function isPdfFile(mediaType: string, name: string): boolean {
  return mediaType === "application/pdf" || /\.pdf$/i.test(name);
}

/** A Word, Excel or PowerPoint file, by type or by name. */
export function isOfficeFile(mediaType: string, name: string): boolean {
  return officeKindOf(mediaType, name) !== undefined;
}

/** A document that is read into text on the way in: a PDF or an Office file. */
export function isDocument(mediaType: string, name: string): boolean {
  return isPdfFile(mediaType, name) || isOfficeFile(mediaType, name);
}

/** What a turn can carry: a picture, a text file, or a document (read as text on the way in). */
export function isReadable(mediaType: string, name: string): boolean {
  return isImage(mediaType) || isTextual(mediaType, name) || isDocument(mediaType, name);
}

/**
 * Attachments with every document (a PDF, a Word, Excel or PowerPoint file)
 * turned into the text file it reads as, so the rest of the path (the
 * blocks, both engines, the transcript) sees only pictures and text. Done
 * once, at the door, rather than in each engine.
 */
export async function readAttachments(attachments: Attachment[]): Promise<Attachment[]> {
  const out: Attachment[] = [];
  for (const file of attachments) {
    if (!isDocument(file.mediaType, file.name) || isTextual(file.mediaType, file.name)) {
      out.push(file);
      continue;
    }
    const bytes = Buffer.from(file.data, "base64");
    if (bytes.byteLength > MAX_BYTES) {
      throw new Error(`${file.name} is ${Math.round(bytes.byteLength / 1024 / 1024)}MB; the limit is ${MAX_BYTES / 1024 / 1024}MB`);
    }
    let note: string;
    let text: string;
    if (isPdfFile(file.mediaType, file.name)) {
      const read = await pdfText(new Uint8Array(bytes));
      note = `${read.pages} page${read.pages === 1 ? "" : "s"}${read.truncated ? ", cut at the cap" : ""}`;
      text = read.text;
    } else {
      const read = officeText(new Uint8Array(bytes), file.name, file.mediaType);
      note = officeNote(read);
      text = read.text;
    }
    out.push({ name: file.name, mediaType: "text/plain", data: Buffer.from(`[${file.name}: ${note}]\n${text}`, "utf8").toString("base64") });
  }
  return out;
}

export function isTextual(mediaType: string, name: string): boolean {
  if (TEXTUAL.test(mediaType)) return true;
  // Browsers report an empty or generic type for plenty of ordinary text
  // files, so the extension gets a say when the type says nothing useful.
  if (
    mediaType === "" ||
    mediaType === "application/octet-stream" ||
    !mediaType.includes("/")
  ) {
    return TEXT_EXTENSIONS.test(name);
  }
  return false;
}

export function parseAttachments(raw: unknown): Attachment[] {
  if (!Array.isArray(raw)) return [];
  const out: Attachment[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const a = entry as Record<string, unknown>;
    const name = typeof a["name"] === "string" ? a["name"] : "";
    const mediaType = typeof a["mediaType"] === "string" ? a["mediaType"] : "";
    const data = typeof a["data"] === "string" ? a["data"] : "";
    if (!name || !data) continue;
    out.push({ name, mediaType, data });
  }
  return out;
}

/**
 * Turn attachments into content blocks, or say why one cannot be used.
 *
 * Throws rather than dropping: an attachment that silently vanishes leaves the
 * owner asking about a picture the model was never shown.
 */
export function attachmentBlocks(attachments: Attachment[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const file of attachments) {
    const bytes = Math.floor((file.data.length * 3) / 4);
    if (bytes > MAX_BYTES) {
      throw new Error(
        `${file.name} is ${Math.round(bytes / 1024 / 1024)}MB; the limit is ${MAX_BYTES / 1024 / 1024}MB`,
      );
    }
    if (isImage(file.mediaType)) {
      blocks.push({
        type: "image",
        name: file.name,
        mediaType: file.mediaType,
        data: file.data,
      });
      continue;
    }
    if (isTextual(file.mediaType, file.name)) {
      blocks.push({
        type: "file",
        name: file.name,
        text: Buffer.from(file.data, "base64").toString("utf8"),
      });
      continue;
    }
    throw new Error(
      `${file.name} (${file.mediaType || "unknown type"}) cannot be read by the model. Attach an image, a text file or a PDF, or write it into the workspace and point the agent at it.`,
    );
  }
  return blocks;
}
