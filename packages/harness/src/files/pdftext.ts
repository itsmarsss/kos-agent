/**
 * The words in a PDF.
 *
 * A PDF reached the model nowhere: an attached one was refused as a type it
 * could not read, a fetched one came back as bytes, and one in the
 * workspace read as its raw stream. The owner's bills, papers and manuals
 * are PDFs. This hands over the text, page by page, with the same cap the
 * other readers keep, and nothing else of the file: a PDF is read, never
 * run, so its scripts, fonts and links do not reach anything.
 */

export interface PdfText {
  text: string;
  pages: number;
  /** True when a cap (on the text, or the pages one read walks) cut the read short. */
  truncated: boolean;
  /** The first and last page read, the last in part when the text cap cut it. */
  from: number;
  to: number;
  /** Where to read on from, when the read was cut short. */
  next?: number;
}

/** Pages to read, counted from 1, both ends kept; the whole file when unset. */
export interface PageRange {
  from?: number;
  to?: number;
}

/** About what a model can take in one go without the rest of the turn going. */
export const PDF_TEXT_MAX = 200_000;

/** The most pages one read walks: a thousand blank pages carry no text to stop it at the cap. */
export const PDF_PAGES_PER_READ = 1000;

/** How long one read of a PDF may take, opening it included. */
export const PDF_READ_MS = 30_000;

/** Enough of the file's head to know it is one. */
export function isPdf(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

type PdfDocument = Awaited<ReturnType<typeof import("pdfjs-dist/legacy/build/pdf.mjs").getDocument>["promise"]>;

/** The PDF opened, handed to `use`, and closed again whatever happens. */
async function withPdf<T>(bytes: Uint8Array, use: (doc: PdfDocument) => Promise<T>): Promise<T> {
  if (!isPdf(bytes)) throw new Error("not a PDF: the file does not start with %PDF");
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({
    // A copy: the reader takes the buffer it is given and leaves the
    // caller's empty, so a second read of the same bytes saw nothing.
    data: bytes.slice(),
    // Read, never run: no font faces built, nothing of the file fetched.
    useSystemFonts: true,
    disableFontFace: true,
    stopAtErrors: false,
  });
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`reading the PDF took more than ${PDF_READ_MS / 1000} s`)), PDF_READ_MS);
  });
  try {
    // A file built to stall the reader is given up on at the deadline, and the reader torn down.
    return await Promise.race([task.promise.then(use), late]);
  } finally {
    clearTimeout(timer);
    await task.destroy();
  }
}

/** How many pages the PDF has, without reading them. */
export function pdfPages(bytes: Uint8Array): Promise<number> {
  return withPdf(bytes, async (doc) => doc.numPages);
}

/**
 * The file's text, in reading order, each page under a marker; `range` reads
 * part of a long one, as a book is read a chapter at a time.
 */
export function pdfText(bytes: Uint8Array, maxChars = PDF_TEXT_MAX, range: PageRange = {}, maxPages = PDF_PAGES_PER_READ): Promise<PdfText> {
  return withPdf(bytes, async (doc) => {
    const from = Math.max(1, Math.floor(range.from ?? 1));
    const to = Math.min(doc.numPages, Math.floor(range.to ?? doc.numPages));
    if (from > to) throw new Error(`pages ${from} to ${to} are not in it: it has ${doc.numPages} page${doc.numPages === 1 ? "" : "s"}`);
    const parts: string[] = [];
    let length = 0;
    let next: number | undefined;
    let last = from;
    for (let i = from; i <= to; i += 1) {
      if (i - from >= maxPages) {
        next = i;
        break;
      }
      last = i;
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const lines = content.items
        .map((item) => ("str" in item ? `${item.str}${item.hasEOL ? "\n" : ""}` : ""))
        .join("")
        .replace(/[ \t]+\n/g, "\n")
        .trim();
      const block = `${doc.numPages > 1 ? `--- page ${i} of ${doc.numPages} ---\n` : ""}${lines}`;
      if (length + block.length > maxChars) {
        parts.push(block.slice(0, Math.max(0, maxChars - length)));
        next = i;
        break;
      }
      parts.push(block);
      length += block.length + 2;
    }
    return { text: parts.join("\n\n"), pages: doc.numPages, truncated: next !== undefined, from, to: last, ...(next !== undefined ? { next } : {}) };
  });
}
