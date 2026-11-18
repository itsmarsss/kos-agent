import { describe, expect, it } from "vitest";

import { beyondAutoByName } from "./beyondauto.js";

describe("beyondAutoByName", () => {
  it("names a tool that spends money or deletes", () => {
    expect(beyondAutoByName("mcp.stripe.create_payment")).toBe("may spend money");
    expect(beyondAutoByName("mcp.shop.checkout")).toBe("may spend money");
    expect(beyondAutoByName("mcp.drive.delete_file")).toBe("may delete something outside the workspace");
    expect(beyondAutoByName("mcp.github.removeLabel")).toBe("may delete something outside the workspace");
  });

  it("leaves other names alone, words that only contain one included", () => {
    expect(beyondAutoByName("mcp.drive.list_files")).toBe(false);
    expect(beyondAutoByName("mcp.notes.reorder")).toBe(false);
    expect(beyondAutoByName("mcp.maps.dropoff_time")).toBe(false);
    expect(beyondAutoByName("mcp.chat.display")).toBe(false);
  });
});
