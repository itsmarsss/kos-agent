import { isReadable, type Attachment } from "@kos/harness";

/**
 * Files a device sends with the owner's words: a picture, a PDF, a text file.
 *
 * A phone's frames over the Wi-Fi are at most 512 KB (lan.ts), and a photo is
 * more, so each file comes ahead of the words as `chat.attach` events, each one
 * part of its base64, and the `chat.send` after them names the files by the ids
 * the device gave them. They are held here per device, bounded, until a send
 * takes them or they go stale; one that never arrived whole is refused with the
 * words rather than dropped, so the owner never asks about a picture KOS was
 * never shown.
 */

/** Base64 characters in one part: well inside the Wi-Fi listener's frame with the event around it. */
export const ATTACH_PART_CHARS = 256 * 1024;
/** Bytes in one file, as the model's path takes them (harness attachments.ts). */
export const ATTACH_FILE_BYTES = 5 * 1024 * 1024;
/** Files with one message, and held for one device at once. */
export const ATTACH_FILES = 4;
/** How long a file waits for the words it goes with. */
export const ATTACH_KEPT_MS = 5 * 60_000;

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const NAME_MAX = 200;
const TYPE_MAX = 120;
/** The base64 of the largest file, and the parts it takes. */
const FILE_CHARS = Math.ceil(ATTACH_FILE_BYTES / 3) * 4;
const PARTS_MAX = Math.ceil(FILE_CHARS / ATTACH_PART_CHARS);

interface Arriving {
  name: string;
  mediaType: string;
  parts: (string | undefined)[];
  got: number;
  chars: number;
  at: number;
  /** Why it was refused on the way in, said when the words that name it come. */
  refused?: string;
}

export class AttachmentInbox {
  private readonly byDevice = new Map<string, Map<string, Arriving>>();

  constructor(private readonly now: () => number = Date.now) {}

  /** One part of a file, as `chat.attach` carries it. A bad part refuses its file. */
  part(device: string, data: Record<string, unknown>): void {
    const id = data["id"];
    if (typeof id !== "string" || !ID.test(id)) return;
    const held = this.held(device);
    let file = held.get(id);
    if (!file) {
      if (held.size >= ATTACH_FILES) return;
      file = this.begin(data);
      held.set(id, file);
    }
    if (file.refused) return;
    const refused = this.add(file, data);
    if (refused) {
      file.refused = refused;
      file.parts = [];
    }
  }

  /**
   * The files `chat.send` names, whole, taken off the device's hold; or why
   * they cannot go. None named is none taken.
   */
  take(device: string, ids: unknown): { files: Attachment[] } | { refused: string } {
    if (ids === undefined) return { files: [] };
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) return { refused: "The files with that message were not named right. Attach them again." };
    if (ids.length > ATTACH_FILES) return { refused: `At most ${ATTACH_FILES} files go with one message.` };
    const held = this.held(device);
    const files: Attachment[] = [];
    for (const id of ids as string[]) {
      const file = held.get(id);
      held.delete(id);
      if (!file || file.got < file.parts.length || file.parts.length === 0) {
        return { refused: file?.refused ?? `${file?.name ?? "A file"} did not arrive whole. Attach it again.` };
      }
      files.push({ name: file.name, mediaType: file.mediaType, data: file.parts.join("") });
    }
    return { files };
  }

  /** What a device has on its way is dropped with its line. */
  forget(device: string): void {
    this.byDevice.delete(device);
  }

  /** The device's hold, stale files dropped. */
  private held(device: string): Map<string, Arriving> {
    const held = this.byDevice.get(device) ?? new Map<string, Arriving>();
    this.byDevice.set(device, held);
    const now = this.now();
    for (const [id, file] of held) if (now - file.at > ATTACH_KEPT_MS) held.delete(id);
    return held;
  }

  /** A file's first part met: its name, type and how many parts it comes in. */
  private begin(data: Record<string, unknown>): Arriving {
    const name = typeof data["name"] === "string" ? data["name"].replace(/[\\/\u0000-\u001f]/g, " ").trim().slice(0, NAME_MAX) : "";
    const mediaType = typeof data["mediaType"] === "string" ? data["mediaType"].trim().toLowerCase().slice(0, TYPE_MAX) : "";
    const parts = data["parts"];
    const file: Arriving = { name: name || "file", mediaType, parts: [], got: 0, chars: 0, at: this.now() };
    if (!name) file.refused = "A file came with no name. Attach it again.";
    else if (!isReadable(mediaType, name)) file.refused = `KOS cannot read ${name}: send a picture, a PDF, an Office file or a text file.`;
    else if (typeof parts !== "number" || !Number.isInteger(parts) || parts < 1 || parts > PARTS_MAX) file.refused = `${name} is more than KOS takes: files go up to ${ATTACH_FILE_BYTES / 1024 / 1024} MB.`;
    else file.parts = Array.from({ length: parts });
    return file;
  }

  /** One part put in its place; why it cannot be, else undefined. */
  private add(file: Arriving, data: Record<string, unknown>): string | undefined {
    const part = data["part"];
    const chunk = data["data"];
    const whole = `${file.name} did not arrive whole. Attach it again.`;
    if (typeof part !== "number" || !Number.isInteger(part) || part < 0 || part >= file.parts.length || file.parts[part] !== undefined) return whole;
    if (typeof chunk !== "string" || chunk.length === 0 || chunk.length > ATTACH_PART_CHARS || !BASE64.test(chunk)) return whole;
    // Only the last part may end short or padded, so the parts join into one base64.
    if (part < file.parts.length - 1 && (chunk.length % 4 !== 0 || chunk.endsWith("="))) return whole;
    file.chars += chunk.length;
    if (file.chars > FILE_CHARS) return `${file.name} is more than KOS takes: files go up to ${ATTACH_FILE_BYTES / 1024 / 1024} MB.`;
    file.parts[part] = chunk;
    file.got += 1;
    return undefined;
  }
}
