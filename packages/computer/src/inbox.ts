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
/** The pictures a model takes, by what their bytes begin with; the phone sends its photos as JPEG. */
const PICTURES: { type: string; is: (b: Buffer) => boolean }[] = [
  { type: "image/jpeg", is: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: "image/png", is: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { type: "image/gif", is: (b) => b.subarray(0, 4).toString("latin1") === "GIF8" },
  { type: "image/webp", is: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
];
const OFFICE = /\.(docx|xlsx|pptx)$/i;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const NAME_MAX = 200;
const TYPE_MAX = 120;
/**
 * Why a whole file cannot go, or undefined: past the model's limit, as it measures it (harness attachments.ts, from
 * the base64's length), or not what it says it is. A picture must be one a model takes, by its bytes; a PDF and an
 * Office file by theirs; a text file must read as text.
 */
function contentRefusal(name: string, mediaType: string, data: string): string | undefined {
  if (Math.floor((data.length * 3) / 4) > ATTACH_FILE_BYTES) return tooBig(name);
  const head = Buffer.from(data.slice(0, 5_464), "base64");
  if (mediaType.startsWith("image/")) {
    const picture = PICTURES.find((p) => p.type === (mediaType === "image/jpg" ? "image/jpeg" : mediaType));
    if (!picture) return `KOS takes pictures as JPEG, PNG, GIF or WebP, so ${name} cannot go.`;
    return picture.is(head) ? undefined : `${name} is not the picture it says it is.`;
  }
  if (mediaType === "application/pdf" || /\.pdf$/i.test(name)) return head.subarray(0, 5).toString("latin1") === "%PDF-" ? undefined : `${name} is not the PDF it says it is.`;
  if (OFFICE.test(name)) return head[0] === 0x50 && head[1] === 0x4b ? undefined : `${name} is not the Office file it says it is.`;
  // Text, which a NUL never is: what is not text is not read as text.
  return head.includes(0) ? `${name} is not the text file it says it is.` : undefined;
}

const tooBig = (name: string): string => `${name} is more than KOS takes: files go up to ${ATTACH_FILE_BYTES / 1024 / 1024} MB.`;

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
    } else if (data["part"] === 0) {
      // A file's first part again is the file sent again (after a dropped line, say): it starts over.
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
      const data = file.parts.join("");
      const refused = contentRefusal(file.name, file.mediaType, data);
      if (refused) return { refused };
      files.push({ name: file.name, mediaType: file.mediaType, data });
    }
    return { files };
  }

  /** What the devices not on a line had on their way is dropped: a device gone or unpaired keeps nothing here. */
  keepOnly(online: ReadonlySet<string>): void {
    for (const device of this.byDevice.keys()) if (!online.has(device)) this.byDevice.delete(device);
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
    else if (mediaType.startsWith("image/") && !PICTURES.some((p) => p.type === mediaType || (mediaType === "image/jpg" && p.type === "image/jpeg"))) file.refused = `KOS takes pictures as JPEG, PNG, GIF or WebP, so ${name} cannot go.`;
    else if (typeof parts !== "number" || !Number.isInteger(parts) || parts < 1 || parts > PARTS_MAX) file.refused = tooBig(name);
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
    if (file.chars > FILE_CHARS) return tooBig(file.name);
    file.parts[part] = chunk;
    file.got += 1;
    return undefined;
  }
}
