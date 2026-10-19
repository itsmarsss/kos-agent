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
  /** True when the cap cut the text short. */
  truncated: boolean;
}

/** About what a model can take in one go without the rest of the turn going. */
export const PDF_TEXT_MAX = 200_000;

/** Enough of the file's head to know it is one. */
export function isPdf(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

/** The file's text, in reading order, each page under a marker. */
export async function pdfText(bytes: Uint8Array, maxChars = PDF_TEXT_MAX): Promise<PdfText> {
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
  const doc = await task.promise;
  try {
    const parts: string[] = [];
    let length = 0;
    let truncated = false;
    for (let i = 1; i <= doc.numPages; i += 1) {
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
        truncated = true;
        break;
      }
      parts.push(block);
      length += block.length + 2;
    }
    return { text: parts.join("\n\n"), pages: doc.numPages, truncated };
  } finally {
    await task.destroy();
  }
}
