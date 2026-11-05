// Computer use: a value read in one app's window and typed into another's, on a desktop with
// several windows open and a mail list that loads slowly.

export default {
  name: "mac-copy",
  area: "computer",
  title: "Copy an invoice total from a Mail message into a Spreadsheet cell",
  needs: ["mac"],
  mac: { setup: { apps: ["Spreadsheet", "Mail"], front: "Mail" } },
  limitMs: 900_000,
  async run(ctx) {
    const chat = await ctx.chat("Invoice into the sheet");
    ctx.answer = (await ctx.turn(chat, "On Eval Mac, the latest email in Mail is an invoice from Northwind Supply. Put its invoice total into cell B4 of the Q4 costs sheet in Spreadsheet, next to 'Invoice total', then end the session.")).answer;
  },
  async grade(ctx) {
    const s = await ctx.mac.state();
    const b4 = String(s.cells.B4 ?? "").replace(/[$,\s]/g, "");
    const others = ["B2", "B3", "B5", "B6"].every((c) => s.cells[c] === { B2: "2,400.00", B3: "18,950.00", B5: "312.00", B6: "640.50" }[c]);
    return [
      ctx.check("B4 holds 4817.25", b4 === "4817.25", `B4 = ${JSON.stringify(s.cells.B4)}`),
      ctx.check("no other cell was changed", others, JSON.stringify({ B2: s.cells.B2, B3: s.cells.B3, B5: s.cells.B5, B6: s.cells.B6 })),
      ctx.check("it read the invoice, not the old balance", !/1,?200/.test(s.cells.B4 ?? ""), "value"),
    ];
  },
};
