import { describe, expect, it } from "vitest";

import { middleEllipsis, splitExtension } from "./names.js";

/** A line `room` characters wide: each character one unit, as a monospace font draws. */
const within = (room: number) => (text: string): boolean => text.length <= room;

describe("a name cut in the middle", () => {
  it("is the name itself when it fits", () => {
    expect(middleEllipsis("notes.md", within(8))).toBe("notes.md");
  });

  it("keeps the start, the end and a file's extension, as long as the room allows", () => {
    const name = "Early_Careers_-_Software.pdf";
    expect(middleEllipsis(name, within(20))).toBe("Early_Ca…oftware.pdf");
    expect(middleEllipsis(name, within(20)).length).toBe(20);
    expect(middleEllipsis(name, within(10))).toBe("Ear…re.pdf");
  });

  it("balances a folder's or an extensionless name's two ends", () => {
    expect(middleEllipsis("3824874585067348897", within(9), false)).toBe("3824…8897");
    expect(middleEllipsis("applications.2026", within(9), false)).toBe("appl…2026");
  });

  it("keeps at least the ellipsis and the extension where nothing else fits", () => {
    expect(middleEllipsis("a-very-long-name.xlsx", within(2))).toBe("….xlsx");
  });

  it("reads only a short ending as an extension", () => {
    expect(splitExtension("report.final.pdf", true)).toEqual(["report.final", ".pdf"]);
    expect(splitExtension("archive.this-is-not-an-extension", true)).toEqual(["archive.this-is-not-an-extension", ""]);
    expect(splitExtension(".env", true)).toEqual([".env", ""]);
    expect(splitExtension("folder.d", false)).toEqual(["folder.d", ""]);
  });
});
