import { toPdf } from "../tools/pdf.js";

/**
 * A real PDF grown to about `bytes` by an incremental update that adds one
 * unreferenced stream, as a scan's images make a short document large.
 */
export function pdfOf(bytes: number, rows: Record<string, string>[] = [{ item: "kettle", price: "42" }]): string {
  const pdf = toPdf(rows, "Shopping");
  const head = pdf.toString("latin1");
  const prev = Number(/startxref\n(\d+)/.exec(head)![1]);
  const size = Number(/\/Size (\d+)/.exec(head)![1]);
  const fill = Math.max(0, bytes - pdf.byteLength - 300);
  const object = `${size} 0 obj\n<< /Length ${fill} >>\nstream\n`;
  const tail = (xref: number): string =>
    `\nendstream\nendobj\nxref\n0 1\n0000000000 65535 f \n${size} 1\n${String(pdf.byteLength).padStart(10, "0")} 00000 n \ntrailer\n<< /Size ${size + 1} /Root 1 0 R /Prev ${prev} >>\nstartxref\n${xref}\n%%EOF\n`;
  const xref = pdf.byteLength + object.length + fill + "\nendstream\nendobj\n".length;
  return Buffer.concat([pdf, Buffer.from(object, "latin1"), Buffer.alloc(fill, 0x20), Buffer.from(tail(xref), "latin1")]).toString("base64");
}
