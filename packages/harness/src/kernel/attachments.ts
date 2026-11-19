import { IMAGE_MAX_BYTES, forModel, imageTypeOf } from "../files/images.js";
import { officeKindOf, officeNote, officeText } from "../files/office.js";
import { pdfPages, pdfText } from "../files/pdftext.js";
import type { ContentBlock } from "../models/types.js";

/**
 * Files the owner attached to a message.
 *
 * Two kinds reach a model at all: an image, which travels as bytes, and text,
 * which is inlined with its filename so the model knows what it is looking at.
 * A picture of any kind becomes a JPEG or PNG the providers take, and a
 * document the text it reads as, before they get that far; a file too big to
 * read in whole is named to the model where it was kept, to read from there.
 * Anything else is refused here rather than sent as something the provider
 * will reject or, worse, silently ignore.
 */

export interface Attachment {
  name: string;
  /** Media type as reported by the browser, e.g. "image/png". */
  mediaType: string;
  /** Base64 payload, without the data: prefix. */
  data: string;
  /** Where it is kept in the workspace, when it is, so a surface that cannot carry it can point at it. */
  path?: string;
}

/** A file kept from a message's attachments: what it was called, and where it now lives in the workspace. */
export interface KeptFile {
  name: string;
  /** Workspace-relative path. */
  path: string;
}

const MB = 1024 * 1024;

/**
 * The most KOS takes of one file, sent with a message or put in a folder,
 * from any surface: a scanned book or a long phone video fits. A file comes
 * as base64 in one request, a third larger again, held in memory until it is
 * written, so this is what a host holds of one file, and of four with one
 * message, without trouble. What a model is sent of a file is smaller still:
 * see DOCUMENT_MAX_BYTES, TEXT_MAX_BYTES and files/images.ts.
 */
export const FILE_MAX_BYTES = 100 * MB;

/**
 * The most of a document (a PDF, a Word, Excel or PowerPoint file) read into
 * the turn: what the model providers take of a PDF in one request (Anthropic's
 * is 32 MB). A larger one is kept and named to the model, to read in parts.
 */
export const DOCUMENT_MAX_BYTES = 32 * MB;

/** The most of a text file read into the turn, which takes it whole. */
export const TEXT_MAX_BYTES = 5 * MB;

const TEXTUAL = /^(text\/|image\/svg\+xml|application\/(json|xml|x-yaml|yaml|toml|javascript|typescript|x-tex|x-latex|sql|x-sh|rtf))/;

/** Pictures by name, for a surface that gives no type: browsers and Discord often give none for a HEIC. */
const IMAGE_EXTENSIONS = /\.(jpe?g|png|gif|webp|heic|heif|avif|tiff?|bmp)$/i;

/**
 * Extensions that are text whatever the browser claims. Browsers report an
 * empty or generic type for most of these: .tex came through as "unknown type"
 * and was refused, which is not a thing a reader can act on.
 */
const TEXT_EXTENSIONS =
  /\.(md|markdown|txt|text|csv|tsv|json|jsonl|ya?ml|toml|ini|cfg|conf|env|log|tex|bib|cls|sty|rst|org|adoc|ts|tsx|js|jsx|mjs|cjs|css|scss|less|html?|xml|svg|sql|sh|bash|zsh|fish|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|pl|lua|r|jl|vue|svelte|astro|gradle|dockerfile|makefile|gitignore|npmrc|lock)$/i;

/** A recording, by type or by name: a voice note from a phone, an audio file. */
export function isAudio(mediaType: string, name: string): boolean {
  return mediaType.startsWith("audio/") || (/\.(ogg|oga|opus|mp3|m4a|aac|wav|flac|webm)$/i.test(name) && !mediaType.startsWith("video/"));
}

export function isImage(mediaType: string): boolean {
  return mediaType.startsWith("image/");
}

/** A picture by what was claimed of it, its type or its name; its bytes settle it later. */
function claimsPicture(mediaType: string, name: string): boolean {
  return (isImage(mediaType) || IMAGE_EXTENSIONS.test(name)) && !isTextual(mediaType, name);
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
  return claimsPicture(mediaType, name) || isTextual(mediaType, name) || isDocument(mediaType, name);
}

/**
 * Attachments as a model takes them, made so once, at the door, rather than
 * in each engine, so the rest of the path (the blocks, both engines, the
 * transcript) sees only pictures it can send and text. Each is known by its
 * bytes, not by what it was called: a picture of any kind becomes a JPEG or
 * a PNG within the providers' limits; a document (a PDF, a Word, Excel or
 * PowerPoint file) the text it reads as; and a document or text file too big
 * to read in whole, a note of where it was kept, to read from there.
 */
export async function readAttachments(attachments: Attachment[]): Promise<Attachment[]> {
  const out: Attachment[] = [];
  for (const file of attachments) {
    assertFits(file);
    const bytes = Buffer.from(file.data, "base64");
    // What its name or type says is text is read as text, even when its first bytes look like a picture's.
    if (isTextual(file.mediaType, file.name)) {
      const how = "with search.grep, or files.read a part at a time (offset, limit)";
      out.push(bytes.byteLength > TEXT_MAX_BYTES ? keptNote(file, bytes, "", `a text file is read in up to ${TEXT_MAX_BYTES / MB} MB`, how) : file);
    } else if (imageTypeOf(bytes) || claimsPicture(file.mediaType, file.name)) out.push(await asPicture(file, bytes));
    else if (isDocument(file.mediaType, file.name)) out.push(await asDocument(file, bytes));
    // No model hears a recording: it is kept, and the turn is told where.
    else if (isAudio(file.mediaType, file.name)) {
      if (!file.path) throw new Error(`${file.name} is a recording, and it could not be kept in the workspace`);
      out.push(asText(file, `[${file.name}: a ${megabytes(bytes.byteLength)} recording, kept at ${file.path}. It was not transcribed here.]`));
    } else out.push(file);
  }
  return out;
}

/**
 * A picture as the model takes it, under the name it was sent with; or, when
 * it cannot be made into one, a note saying so and where the file was kept,
 * so one bad picture does not cost the words and the rest their turn.
 */
async function asPicture(file: Attachment, bytes: Buffer): Promise<Attachment> {
  try {
    const image = await forModel(bytes);
    return { name: file.name, mediaType: image.mediaType, data: image.data.toString("base64"), ...(file.path ? { path: file.path } : {}) };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return asText(file, `[${file.name}: ${file.path ? `kept at ${file.path}, but ` : ""}not shown to the model: ${why}.]`);
  }
}

/** A document as the text it reads as, or, past what is read in whole, a note of where it was kept. */
async function asDocument(file: Attachment, bytes: Buffer): Promise<Attachment> {
  const pdf = isPdfFile(file.mediaType, file.name);
  if (bytes.byteLength > DOCUMENT_MAX_BYTES) {
    const pages = pdf ? await pdfPages(new Uint8Array(bytes)).catch(() => undefined) : undefined;
    const what = pdf ? ` PDF${pages ? ` of ${pages} page${pages === 1 ? "" : "s"}` : ""}` : "";
    const how = pdf ? "with files.read, some pages at a time (from, to)" : "with files.read";
    return keptNote(file, bytes, what, `a document is read in up to ${DOCUMENT_MAX_BYTES / MB} MB, the most the model providers take of a PDF`, how);
  }
  let note: string;
  let text: string;
  if (pdf) {
    const read = await pdfText(new Uint8Array(bytes));
    note = `${read.pages} page${read.pages === 1 ? "" : "s"}${read.next !== undefined ? `, cut short at page ${read.to}${file.path ? `; read on in ${file.path} with files.read from page ${read.next}` : ""}` : ""}`;
    text = read.text;
  } else {
    const read = officeText(new Uint8Array(bytes), file.name, file.mediaType);
    note = officeNote(read);
    text = read.text;
  }
  return asText(file, `[${file.name}: ${note}]\n${text}`);
}

/**
 * What the model is told of a file too big to read in whole: what it is,
 * where it was kept, and how to read it from there with KOS's own tools.
 */
function keptNote(file: Attachment, bytes: Buffer, what: string, why: string, how: string): Attachment {
  const size = megabytes(bytes.byteLength);
  if (!file.path) throw new Error(`${file.name} is ${size}; ${why}, and it could not be kept in the workspace to be read from there`);
  return asText(file, `[${file.name}: a ${size}${what}, kept at ${file.path}. Too big to read in whole here (${why}); read it from there ${how}.]`);
}

function asText(file: Attachment, text: string): Attachment {
  return { name: file.name, mediaType: "text/plain", data: Buffer.from(text, "utf8").toString("base64"), ...(file.path ? { path: file.path } : {}) };
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

/** Bytes a base64 payload decodes to, without decoding it. */
export function decodedBytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

/** Megabytes as a reader says them: "6.2 MB". */
export function megabytes(bytes: number): string {
  return `${(bytes / MB).toFixed(1)} MB`;
}

/**
 * Refuse a file past what KOS takes of one, saying the limit and why. Sized
 * from the encoding, so an oversize file is refused before it is decoded or
 * kept.
 */
export function assertFits(file: Pick<Attachment, "name" | "data">): void {
  const bytes = decodedBytes(file.data);
  if (bytes > FILE_MAX_BYTES) throw new Error(`${file.name} is ${megabytes(bytes)}; a file can be up to ${FILE_MAX_BYTES / MB} MB, the most KOS takes of one`);
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
    const kept = file.path ? { path: file.path } : {};
    // Text first: an SVG says image/ and is text.
    if (isTextual(file.mediaType, file.name)) {
      if (decodedBytes(file.data) > TEXT_MAX_BYTES) throw new Error(`${file.name} is ${megabytes(decodedBytes(file.data))}; a text file is read in up to ${TEXT_MAX_BYTES / MB} MB`);
      blocks.push({
        type: "file",
        name: file.name,
        text: Buffer.from(file.data, "base64").toString("utf8"),
        ...kept,
      });
      continue;
    }
    if (isImage(file.mediaType)) {
      // Made to fit by readAttachments; checked again, as a provider refuses the whole request over one picture.
      if (file.data.length > IMAGE_MAX_BYTES) throw new Error(`${file.name} is ${megabytes(decodedBytes(file.data))}; a picture is sent to the model at up to ${IMAGE_MAX_BYTES / MB} MB`);
      blocks.push({
        type: "image",
        name: file.name,
        mediaType: file.mediaType,
        data: file.data,
        ...kept,
      });
      continue;
    }
    throw new Error(
      `${file.name} (${file.mediaType || "unknown type"}) cannot be read by the model. Attach an image, a text file or a PDF, or write it into the workspace and point the agent at it.`,
    );
  }
  return blocks;
}
