import { describe, expect, it } from "vitest";

import { assessSkillRisk } from "./risk.js";

describe("assessSkillRisk", () => {
  it("accepts a read-only script as safe", () => {
    const src = `
      import Database from "better-sqlite3";
      const db = new Database(process.argv[2]);
      const rows = db.prepare("SELECT amount FROM budget_tx").all();
      console.log(JSON.stringify(rows));
    `;
    expect(assessSkillRisk(src)).toEqual({ risky: false, reasons: [] });
  });

  const risky: [string, string, string][] = [
    ["network fetch", 'await fetch("https://example.com");', "network access"],
    ["child process", 'import { exec } from "node:child_process";', "process execution"],
    ["environment", "const k = process.env.OPENAI_API_KEY;", "credentials or environment"],
    ["secret template", 'const k = "{{secret:stripe}}";', "credentials or environment"],
    ["eval", 'eval("1+1");', "dynamic code execution"],
    ["new Function", 'new Function("return 1")();', "dynamic code execution"],
    ["file write", 'writeFileSync("out.txt", "x");', "filesystem writes"],
    ["file delete", 'rmSync("thing");', "filesystem writes"],
    ["sql insert", 'db.prepare("INSERT INTO tx (a) VALUES (1)").run();', "database writes"],
    ["sql delete", 'db.prepare("delete from tx").run();', "database writes"],
    ["sql drop", 'db.exec("DROP TABLE tx");', "database writes"],
    ["process exit", "process.exit(1);", "process control"],
  ];

  for (const [label, src, reason] of risky) {
    it(`flags ${label}`, () => {
      const got = assessSkillRisk(src);
      expect(got.risky).toBe(true);
      expect(got.reasons).toContain(reason);
    });
  }

  it("treats empty or non-string source as risky", () => {
    expect(assessSkillRisk("").risky).toBe(true);
    expect(assessSkillRisk("   ").risky).toBe(true);
    expect(assessSkillRisk(undefined as unknown as string).risky).toBe(true);
  });

  it("ignores markers that appear only in comments", () => {
    const src = `
      // this script does not call fetch( or writeFileSync(
      /* nor does it INSERT INTO anything */
      console.log("hi");
    `;
    expect(assessSkillRisk(src).risky).toBe(false);
  });

  it("still flags markers inside string literals", () => {
    // A SQL write or a URL lives in a string; that is the thing to catch.
    expect(assessSkillRisk('const q = "INSERT INTO tx VALUES (1)";').risky).toBe(true);
  });

  it("reports every reason it found, not just the first", () => {
    const got = assessSkillRisk('fetch("x"); writeFileSync("y","z"); process.env.A;');
    expect(got.reasons.length).toBeGreaterThanOrEqual(3);
  });
});
