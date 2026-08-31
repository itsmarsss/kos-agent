import type { ContentBlock } from "../models/types.js";

/**
 * Files the owner attached to a message.
 *
 * Two kinds reach a model at all: an image, which travels as bytes, and text,
 * which is inlined with its filename so the model knows what it is looking at.
 * Anything else is refused here rather than sent as something the provider
 * will reject or, worse, silently ignore.
 */

export interface Attachment {
  name: string;
  /** Media type as reported by the browser, e.g. "image/png". */
  mediaType: string;
  /** Base64 payload, without the data: prefix. */
  data: string;
}

/** Bytes per attachment. Base64 inflates by a third, and prompts have limits. */
const MAX_BYTES = 5 * 1024 * 1024;

const TEXTUAL = /^(text\/|application\/(json|xml|x-yaml|yaml|toml|javascript|typescript))/;

export function isImage(mediaType: string): boolean {
  return mediaType.startsWith("image/");
}

export function isTextual(mediaType: string, name: string): boolean {
  if (TEXTUAL.test(mediaType)) return true;
  // Browsers report an empty or generic type for plenty of ordinary text
  // files, so the extension gets a say when the type says nothing useful.
  if (mediaType === "" || mediaType === "application/octet-stream") {
    return /\.(md|txt|csv|tsv|json|ya?ml|toml|log|ts|tsx|js|jsx|css|html|sql|sh)$/i.test(
      name,
    );
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
      blocks.push({ type: "image", mediaType: file.mediaType, data: file.data });
      continue;
    }
    if (isTextual(file.mediaType, file.name)) {
      const text = Buffer.from(file.data, "base64").toString("utf8");
      blocks.push({
        type: "text",
        text: `Attached file ${file.name}:\n\n${text}`,
      });
      continue;
    }
    throw new Error(
      `${file.name} (${file.mediaType || "unknown type"}) cannot be read by the model. Attach an image or a text file, or write it into the workspace and point the agent at it.`,
    );
  }
  return blocks;
}
