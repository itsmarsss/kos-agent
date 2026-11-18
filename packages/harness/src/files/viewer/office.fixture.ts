import { deflateRawSync } from "node:zlib";

import { utils, write } from "xlsx";

import { writeZip } from "../zip.js";

/**
 * Small Office files for the viewers' tests, written as Word, PowerPoint
 * and Excel write them: the parts, their relationships, and the XML each
 * viewer reads. Also the hostile ones: a picture from the web, a script in
 * the text, a zip that inflates to far more than it is.
 */

/** A one-pixel PNG. */
export const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';

const run = (text: string, props = ""): string => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const para = (inner: string, pPr = ""): string => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${inner}</w:p>`;

export function docx({ body, rels = "", media = {} }: { body: string; rels?: string; media?: Record<string, Uint8Array> }): Uint8Array {
  return writeZip(
    {
      "[Content_Types].xml": '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
      "word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}</w:body></w:document>`,
      "word/styles.xml": `<w:styles ${W}><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Titel"><w:name w:val="Title"/></w:style></w:styles>`,
      "word/numbering.xml": `<w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`,
      "word/_rels/document.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
      ...Object.fromEntries(Object.entries(media).map(([name, bytes]) => [`word/media/${name}`, bytes])),
    },
    { deflate: true },
  );
}

const picture = (rid: string, cx = 952500): string =>
  `<w:r><w:drawing><wp:inline><wp:extent cx="${cx}" cy="${cx}"/><a:graphic><a:graphicData><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip r:embed="${rid}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;

/** A letter: a title, a heading, formatting, both kinds of list, a table with a merge, a picture. */
export function sampleDocx(): Uint8Array {
  return docx({
    body: [
      para(run("Garden plan"), '<w:pStyle w:val="Titel"/>'),
      para(run("Spring beds"), '<w:pStyle w:val="Heading1"/>'),
      para(`${run("Plant the ")}${run("tomatoes", "<w:b/>")}${run(" after the ")}${run("last frost", '<w:i/><w:color w:val="C0392B"/>')}${run(".")}`, '<w:jc w:val="both"/>'),
      para(run("Seeds"), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'),
      para(run("Basil"), '<w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr>'),
      para(run("Soil"), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'),
      para(run("Dig"), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>'),
      para(run("Sow"), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>'),
      `<w:tbl><w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr>${para(run("Bed"))}</w:tc><w:tc>${para(run("Crop"))}</w:tc><w:tc>${para(run("Cost"))}</w:tc></w:tr>` +
        `<w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr>${para("")}</w:tc><w:tc>${para(run("Tomato"))}</w:tc><w:tc>${para(run("$12.50"))}</w:tc></w:tr>` +
        `<w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>${para(run("Total"))}</w:tc><w:tc>${para(run("$12.50"))}</w:tc></w:tr></w:tbl>`,
      para(picture("rIdImg")),
    ].join(""),
    rels: '<Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>',
    media: { "image1.png": PNG_1PX },
  });
}

/** A document that reaches out and tries to run: a picture from the web, markup in its words, a link to a script. */
export function hostileDocx(): Uint8Array {
  return docx({
    body: [
      para(run("&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(2)&gt;")),
      para(picture("rIdWeb")),
      para(`<w:hyperlink r:id="rIdJs">${run("click me")}</w:hyperlink>`),
      para(run("after")),
    ].join(""),
    rels:
      '<Relationship Id="rIdWeb" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://tracker.example/pixel.png" TargetMode="External"/>' +
      '<Relationship Id="rIdJs" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:alert(3)" TargetMode="External"/>',
  });
}

/**
 * A zip bomb with an Office name: one entry whose directory says it is
 * small and which inflates to 200 MB of zeros, built by hand so the
 * declared size lies.
 */
export function zipBomb(name = "word/document.xml", inflated = 200 * 1024 * 1024): Uint8Array {
  const data = deflateRawSync(Buffer.alloc(inflated), { level: 9 });
  const nameBytes = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(1000, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  // The lie: a thousand bytes.
  central.writeUInt32LE(1000, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  const dir = Buffer.concat([central, nameBytes]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(30 + nameBytes.length + data.length, 16);
  return new Uint8Array(Buffer.concat([local, nameBytes, data, dir, end]));
}

/** A workbook in Excel's format, or another of SheetJS's, with a date, a price, a merge and a second sheet. */
export function sampleWorkbook(bookType: "xlsx" | "xls" | "ods" = "xlsx", rows = 3): Uint8Array {
  const book = utils.book_new();
  const data: unknown[][] = [["Item", "Cost", "When"]];
  for (let i = 1; i < rows; i++) data.push([`Row ${i}`, i * 12.5, new Date(Date.UTC(2026, 3, i))]);
  const sheet = utils.aoa_to_sheet(data, { cellDates: true });
  if (sheet.B2) sheet.B2.z = "$#,##0.00";
  sheet["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 0 } }];
  utils.book_append_sheet(book, sheet, "Budget");
  utils.book_append_sheet(book, utils.aoa_to_sheet([["Note"], ["Water daily"]]), "Notes");
  return new Uint8Array(write(book, { type: "buffer", bookType }) as Buffer);
}

const P = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const rels = (list: [string, string, string][]): string =>
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join("")}</Relationships>`;
const xfrm = (x: number, y: number, cx: number, cy: number): string => `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`;

/** A two-slide deck: a title slide from its layout's placeholder, then bullets, a picture, a filled box and notes. */
export function sampleDeck(): Uint8Array {
  const title = `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="en-US"/><a:t>Garden 2026</a:t></a:r></a:p></p:txBody></p:sp>`;
  const bullets = `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr>${xfrm(457200, 1600200, 4000000, 3000000)}</p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="2800" b="1"/><a:t>Tomatoes</a:t></a:r></a:p><a:p><a:pPr lvl="1"/><a:r><a:rPr><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:rPr><a:t>after frost</a:t></a:r></a:p></p:txBody></p:sp>`;
  const pic = `<p:pic><p:nvPicPr><p:cNvPr id="4" name="Pic"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdImg"/></p:blipFill><p:spPr>${xfrm(4800000, 1600200, 3000000, 3000000)}</p:spPr></p:pic>`;
  const box = `<p:sp><p:nvSpPr><p:cNvPr id="5" name="Box"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(0, 6400000, 9144000, 458000)}<a:solidFill><a:srgbClr val="2E7D32"/></a:solidFill></p:spPr></p:sp>`;
  const web = `<p:pic><p:nvPicPr><p:cNvPr id="6" name="Web"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:link="rIdWeb"/></p:blipFill><p:spPr>${xfrm(0, 0, 100, 100)}</p:spPr></p:pic>`;
  const slide = (tree: string, bg = ""): string => `<p:sld ${P}><p:cSld>${bg}<p:spTree>${tree}</p:spTree></p:cSld></p:sld>`;
  return writeZip(
    {
      "ppt/presentation.xml": `<p:presentation ${P}><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`,
      "ppt/_rels/presentation.xml.rels": rels([["rId1", "slideMaster", "slideMasters/slideMaster1.xml"], ["rId2", "slide", "slides/slide1.xml"], ["rId3", "slide", "slides/slide2.xml"]]),
      "ppt/slides/slide1.xml": slide(title, '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFF8E1"/></a:solidFill></p:bgPr></p:bg>'),
      "ppt/slides/_rels/slide1.xml.rels": rels([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"]]),
      "ppt/slides/slide2.xml": slide(`${title.replace("Garden 2026", "What to plant")}${bullets}${pic}${box}${web}`),
      "ppt/slides/_rels/slide2.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rIdImg" Type="${REL}/image" Target="../media/image1.png"/><Relationship Id="rIdWeb" Type="${REL}/image" Target="https://tracker.example/x.png" TargetMode="External"/><Relationship Id="rIdN" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide2.xml"/></Relationships>`,
      "ppt/notesSlides/notesSlide2.xml": `<p:notes ${P}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="N"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>Mention the frost date.</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`,
      "ppt/slideLayouts/slideLayout1.xml": `<p:sldLayout ${P}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr>${xfrm(457200, 274638, 8229600, 1143000)}</p:spPr><p:txBody><a:bodyPr anchor="ctr"/><a:p/></p:txBody></p:sp></p:spTree></p:cSld></p:sldLayout>`,
      "ppt/slideLayouts/_rels/slideLayout1.xml.rels": rels([["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]]),
      "ppt/slideMasters/slideMaster1.xml": `<p:sldMaster ${P}><p:cSld><p:spTree/></p:cSld><p:txStyles><p:titleStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="4400"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="3200"/></a:lvl1pPr><a:lvl2pPr><a:defRPr sz="2400"/></a:lvl2pPr></p:bodyStyle></p:txStyles></p:sldMaster>`,
      "ppt/slideMasters/_rels/slideMaster1.xml.rels": rels([["rId1", "theme", "../theme/theme1.xml"]]),
      "ppt/theme/theme1.xml": `<a:theme ${P}><a:themeElements><a:clrScheme name="t"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:accent1><a:srgbClr val="4472C4"/></a:accent1></a:clrScheme></a:themeElements></a:theme>`,
      "ppt/media/image1.png": PNG_1PX,
    },
    { deflate: true },
  );
}

/** A Keynote file as a zip, keeping its preview where Keynote does. */
export function keynote(): Uint8Array {
  return writeZip({ "Index/Document.iwa": "x", "preview.jpg": Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) });
}
