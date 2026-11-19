import { describe, expect, it } from "vitest";

import { bytesWords } from "./bytes.js";

describe("bytesWords", () => {
  it("says a size in thousands, one decimal under ten", () => {
    expect(bytesWords(1)).toBe("1 byte");
    expect(bytesWords(999)).toBe("999 bytes");
    expect(bytesWords(1500)).toBe("1.5 KB");
    expect(bytesWords(2000)).toBe("2 KB");
    expect(bytesWords(61_825)).toBe("62 KB");
    expect(bytesWords(162_400)).toBe("162 KB");
    expect(bytesWords(999_700)).toBe("1 MB");
    expect(bytesWords(3_200_000)).toBe("3.2 MB");
  });
});
