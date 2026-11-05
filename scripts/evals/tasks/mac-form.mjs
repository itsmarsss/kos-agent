// Computer use: a booking form that rejects the first date format and checks availability slowly;
// KOS has to read the error and recover.

export default {
  name: "mac-form",
  area: "computer",
  title: "Book a table through a form that rejects the first date format",
  needs: ["mac"],
  mac: { setup: { apps: ["Booking"], front: "Booking" } },
  limitMs: 900_000,
  async run(ctx) {
    const chat = await ctx.chat("Table booking");
    ctx.answer = (await ctx.turn(chat, "On Eval Mac, use the Booking app to book a table for 4 people at 7pm on 14 November 2026, under the name Rivera. Tell me the booking reference, then end the session.")).answer;
  },
  async grade(ctx) {
    const s = await ctx.mac.state();
    const b = s.booking.booked;
    return [
      ctx.check("booked: Rivera, 4 guests, 14/11/2026, 19:00", !!b && /rivera/i.test(b.name) && b.guests === 4 && b.date === "14/11/2026" && b.time === "19:00", JSON.stringify(b)),
      ctx.check("the reference is in the answer", /BK-4471/.test(ctx.answer ?? ""), (ctx.answer ?? "").slice(0, 140)),
      ctx.check("recovered from the form's error in few tries", s.booking.attempts <= 3, `${s.booking.attempts} tries`, { required: false }),
    ];
  },
};
