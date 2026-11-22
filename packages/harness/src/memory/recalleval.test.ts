import { describe, expect, it } from "vitest";

import { renderRecallReport, runRecallEval } from "./recalleval.js";

describe("recall eval", () => {
  it("gives each golden turn what it needs and nothing it must not have", async () => {
    const report = await runRecallEval();
    console.log(renderRecallReport(report));
    expect(report.clean).toBe(report.total);
    expect(report.recall).toBe(1);
  });
});
