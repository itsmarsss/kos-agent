import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
import { ModuleLoader, toolRegistryContext } from "../modules/loader.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Workspace } from "../store/workspace.js";
import { exportModule, toCsv, toMarkdown } from "./export.js";

describe("csv rendering", () => {
  it("quotes values containing a comma, quote, or newline", () => {
    const csv = toCsv([
      { a: "plain", b: "has,comma" },
      { a: 'say "hi"', b: "line\nbreak" },
    ]);
    expect(csv).toContain('"has,comma"');
    expect(csv).toContain('"say ""hi"""');
    expect(csv).toContain('"line\nbreak"');
  });

  it("renders a header row and empty for no rows", () => {
    expect(toCsv([{ a: 1, b: 2 }])).toBe("a,b\n1,2\n");
    expect(toCsv([])).toBe("");
  });

  it("renders null as empty rather than the word null", () => {
    expect(toCsv([{ a: null, b: 1 }])).toBe("a,b\n,1\n");
  });
});

describe("markdown rendering", () => {
  it("escapes pipes so columns do not break", () => {
    const md = toMarkdown([{ note: "a | b" }]);
    expect(md).toContain("a \\| b");
  });

  it("flattens newlines inside a cell", () => {
    expect(toMarkdown([{ note: "one\ntwo" }])).toContain("one two");
  });

  it("includes a title and handles no rows", () => {
    expect(toMarkdown([], "Spend")).toBe("# Spend\n\n(no rows)\n");
  });
});

describe("export.query tool", () => {
  let root: string;
  let ws: Workspace;
  let registry: ToolRegistry;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-export-"));
    ws = Workspace.open(root);
    ws.db.exec("CREATE TABLE tx (id INTEGER PRIMARY KEY, amount REAL, note TEXT)");
    const insert = ws.db.prepare("INSERT INTO tx (amount, note) VALUES (?, ?)");
    insert.run(12.5, "coffee");
    insert.run(40, "groceries");

    registry = new ToolRegistry();
    const ctx = toolRegistryContext(registry, {
      workspace: ws,
      db: ws.db,
      secrets: new SecretsRegistry(),
    });
    await new ModuleLoader(ctx).load([exportModule]);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("writes a csv into the workspace and reports the row count", async () => {
    const res = await registry.execute("export.query", {
      query: "SELECT note, amount FROM tx ORDER BY amount",
      path: "exports/spend.csv",
      format: "csv",
    });
    expect(res.isError).toBe(false);
    expect(JSON.parse(res.content)).toMatchObject({
      path: "exports/spend.csv",
      rows: 2,
    });
    const written = readFileSync(join(ws.root, "exports/spend.csv"), "utf8");
    expect(written).toBe("note,amount\ncoffee,12.5\ngroceries,40\n");
  });

  it("writes markdown with a title", async () => {
    await registry.execute("export.query", {
      query: "SELECT note FROM tx ORDER BY note",
      path: "exports/spend.md",
      format: "markdown",
      title: "Spending",
    });
    const written = readFileSync(join(ws.root, "exports/spend.md"), "utf8");
    expect(written).toContain("# Spending");
    expect(written).toContain("| coffee |");
  });

  it("refuses a write query", async () => {
    const res = await registry.execute("export.query", {
      query: "DELETE FROM tx",
      path: "exports/x.csv",
      format: "csv",
    });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/read-only/);
  });

  it("refuses a path escaping the workspace", async () => {
    const res = await registry.execute("export.query", {
      query: "SELECT 1 AS n",
      path: "../escape.csv",
      format: "csv",
    });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/traversal|escape/i);
  });

  it("rejects an unsupported format", async () => {
    const res = await registry.execute("export.query", {
      query: "SELECT 1 AS n",
      path: "exports/x.pdf",
      format: "pdf",
    });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/unsupported format/);
  });

  it("classifies as safe: it cannot write data or leave the jail", () => {
    expect(registry.classify("export.query", {}).tier).toBe("safe");
  });
});
