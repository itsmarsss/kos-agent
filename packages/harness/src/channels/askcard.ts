import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { askView, detailLines, secretFieldWords, summarizeAction, usesSecret, type AskView, type StepLine } from "@kos/shared";

import { cut, discordTime, noPreviews, reachableUrl, splitSummary } from "./discordtext.js";
import { HOST_KEYS } from "./hostkeys.js";
import { literal } from "./mentions.js";
import { offersAlways } from "./offers.js";
import type { ApprovalOutcome, ApprovalRequest } from "./types.js";

/**
 * An approval as Discord shows it, from the view every surface draws
 * (askView): what the call acts on, KOS's words for it, where, each step,
 * why it asks, and when it lapses. Plain message text, not an embed: an
 * embed's title renders no inline code and its fields cannot hold a
 * numbered list of keys.
 */

export const APPROVE_PREFIX = "kos:approve:";
export const DENY_PREFIX = "kos:deny:";
/** Approve and remember: stop asking for this shape of call. */
export const ALWAYS_PREFIX = "kos:always:";

const CODE_FENCE = "```";
const CODE_MAX = 600;
const DETAIL_MAX = 160;
/** How much of what the agent said before asking the card quotes. */
const WHY_MAX = 300;
/** A step's line past this is cut, and the whole call rides in call.json. */
const STEP_MAX = 300;
/** The longest an approval card's text may run, leaving room for the line saying where it came from. */
const CARD_MAX = 1900;
/** The file every step rides in when a card cannot hold them all. */
const STEPS_FILE = "steps.txt";
/** Where the whole call goes when the card cannot show all of it. */
const ARGS_FILE = "call.json";

/** An approval card: its text, the call as files when the text cannot hold it, and whether it places a secret. */
export interface ApprovalCard {
  content: string;
  files?: { attachment: Buffer; name: string }[];
  /** It places a secret: decided only on the dashboard or a paired device, so it offers no Approve here. */
  secret?: boolean;
}

/** Whether an ask places a secret, which no chat surface may approve. */
export function placesSecret(req: ApprovalRequest): boolean {
  return req.secret !== undefined || (req.tool !== undefined && usesSecret(req.tool, req.args ?? {}));
}

/** The model's words, all of it, made literal: a masked link or a mention in them reads as written and does nothing. */
const words = (text: string, max = WHY_MAX): string => literal(cut(text.trim().replace(/\s*\n+\s*/g, " "), max));

/** A step as a line of the numbered list: its words literal, each key as inline code. */
function stepLine(line: StepLine): string {
  return line.map((p) => ("key" in p ? `\`${p.key.replace(/`/g, "'")}\`` : literal(p.text))).join("");
}

/** The plain step, for steps.txt. */
const plainStep = (line: StepLine): string => line.map((p) => ("key" in p ? p.key : p.text)).join("");

function viewOf(req: ApprovalRequest & { tool: string }): AskView {
  return askView({
    tool: req.tool,
    args: req.args ?? {},
    ...(req.reason !== undefined ? { reason: req.reason } : {}),
    ...(req.rule ? { rule: req.rule } : {}),
    ...(req.yours ? { yours: true } : {}),
    ...(req.asksAlways !== undefined ? { asksAlways: req.asksAlways } : {}),
    ...(req.secret ? { secret: req.secret } : {}),
    ...(req.beyondAuto ? { beyondAuto: true } : {}),
    ...(req.detached ? { detached: req.detached } : {}),
    ...(req.taint ? { taint: req.taint } : {}),
    ...(req.names ? { names: req.names } : {}),
    ...(req.where ? { where: req.where } : {}),
    platform: HOST_KEYS,
  });
}

/**
 * The ask's reason when it says where, and the place line does not: "on
 * shop.example" for a browser step with no url or rule to read the site from.
 */
function unplaced(reason: string | null | undefined, view: AskView): string | undefined {
  const said = reason?.trim();
  if (!said || view.risk || /^risky tool$/i.test(said)) return undefined;
  return (view.place ?? "").includes(said.replace(/^(on|in) /i, "")) ? undefined : said;
}

/** What the card's small print says last: why it asks, what it is, and when it lapses. */
function smallPrint(req: ApprovalRequest, risk: string | undefined, note: string | undefined): string {
  const lapse = req.expiresAt !== undefined ? [`lapses ${discordTime(req.expiresAt, "R")}`] : [];
  const parts = [...(risk ? [`⚠ ${literal(risk)}`] : []), ...(req.tool ? [req.tool] : []), `#${req.id}`, ...lapse, ...(note ? [literal(note)] : [])];
  return `-# ${parts.join(" · ")}`;
}

export function approvalText(req: ApprovalRequest): string {
  return approvalCard(req).content;
}

export function approvalCard(req: ApprovalRequest, options: { dashboardUrl?: string } = {}): ApprovalCard {
  // The sentence the ask belongs to, first: what KOS was saying when it
  // reached for the tool. A card that opens with the command alone is a
  // prompt to click yes blind.
  const said = req.why?.trim() ? [`> ${words(req.why)}`] : [];
  // Who is asking, in the headline: "Recap needs your OK", not a bare command.
  const who = req.asker ? literal(req.asker.name) : undefined;
  if (req.tool === undefined) {
    const small = `-# #${req.id}${req.reason ? ` · ${req.reason}` : ""}${req.expiresAt !== undefined ? ` · lapses ${discordTime(req.expiresAt, "R")}` : ""}`;
    return { content: noPreviews([...said, `**${who ? `${who} needs your OK` : "Needs your OK"}** · ${req.text}`, small].join("\n")) };
  }
  const tool = req.tool;
  const args = req.args ?? {};
  const view = viewOf({ ...req, tool });
  if (placesSecret(req)) return secretCard(req, view, said, options.dashboardUrl);
  const asks = `**${who ? `${who} needs your OK` : "Needs your OK"}**`;
  // Titled by what the call acts on; a single action's thing goes in a code
  // block under it, where Discord leaves it alone.
  const steps = view.steps;
  const { head, body } = steps ? { head: view.title } : splitSummary(view.title);
  const lead = [
    ...said,
    `${asks} · ${literal(head)}`,
    // KOS's account of the step, smaller than what the step does.
    ...(view.said ? [`-# KOS says: “${words(view.said)}”`] : []),
    ...(view.place ? [`-# ${literal(view.place)}`] : []),
    // Said before any yes: content the owner did not write came first, and may be what suggested this.
    ...(view.after ? [`⚠ ${literal(view.after)}`] : []),
    // Said before any yes: nobody is waiting on this one's result.
    ...(view.detached ? [`⚠ ${literal(view.detached)}`] : []),
  ];
  // Offered only by the one rule every surface keeps; said why when it is not.
  const note = offersAlways(req) ? undefined : view.alwaysNote;
  const small = smallPrint(req, view.risk, [unplaced(req.reason, view), note].filter(Boolean).join(" · ") || undefined);
  const json = typeof args === "string" ? args : JSON.stringify(args, null, 2);
  const callFile = { attachment: Buffer.from(`${json}\n`, "utf8"), name: ARGS_FILE };
  const join = (lines: string[]): string => noPreviews(lines.join("\n"));

  if (steps) {
    const lines = steps.map((s, i) => `${i + 1}. ${stepLine(s.length ? s : [{ text: "" }])}`);
    const longest = steps.some((s) => plainStep(s).length > STEP_MAX);
    const shown = lines.map((l) => cut(l, STEP_MAX));
    const text = (n: number, more?: string): string => join([...lead, ...shown.slice(0, n), ...(more ? [`-# ${more}`] : []), small]);
    const whole = text(shown.length, longest ? `A step is cut short here; the whole call is in ${ARGS_FILE}` : undefined);
    if (whole.length <= CARD_MAX) return { content: whole, ...(longest ? { files: [callFile] } : {}) };
    // More steps than a message holds: as many as fit, and every one of them
    // in a file on the card, so none is approved unseen.
    const more = (n: number): string => `${steps.length - n} more step${steps.length - n === 1 ? "" : "s"}; every one is in ${STEPS_FILE}, the whole call in ${ARGS_FILE}`;
    let n = shown.length;
    while (n > 0 && text(n, more(n)).length > CARD_MAX) n -= 1;
    return { content: text(n, more(n)), files: [{ attachment: Buffer.from(`${steps.map(plainStep).join("\n")}\n`, "utf8"), name: STEPS_FILE }, callFile] };
  }

  // The command itself, or failing that the arguments, in a code block: a
  // `--include=*.ts` that turned italic was a command you could not read
  // back, and an approval you cannot read is not one you can give.
  const details = body ? [body] : detailLines(tool, args, req.names, req.where).slice(1);
  const code = body ? [cut(body, CODE_MAX)] : details.filter((l) => !l.startsWith("…")).slice(0, 3).map((l) => cut(l, DETAIL_MAX));
  // Anything the card leaves out goes with it whole, in a file: no part of a call is approved unseen.
  const partial = code.length !== details.length || code.some((l, i) => l.includes("…") || l !== details[i]);
  const text = (more?: string): string =>
    join([
      ...lead,
      ...(code.length ? [CODE_FENCE, ...code.map((l) => l.split(CODE_FENCE).join("'''")), CODE_FENCE] : []),
      ...(more ? [`-# ${more}`] : []),
      small,
    ]);
  const whole = text();
  if (!partial && whole.length <= CARD_MAX) return { content: whole };
  return { content: text(`The whole call is in ${ARGS_FILE}`).slice(0, CARD_MAX + 100), files: [callFile] };
}

/**
 * A secret's ask: what it would place and where, and that it is decided on
 * the dashboard. Discord is no proof of who presses, so no Approve.
 */
function secretCard(req: ApprovalRequest, view: AskView, said: string[], dashboardUrl: string | undefined): ApprovalCard {
  const who = req.asker ? `${literal(req.asker.name)} asks to use a secret` : "KOS asks to use a secret";
  const secret = view.secret;
  const fields = secret?.fields.length ? `fills ${secret.fields.map(secretFieldWords).join(", ")}` : undefined;
  const where = secret?.origin ? `On ${hostOf(secret.origin)}` : view.place;
  const link = reachableUrl(dashboardUrl, `#/inbox/${encodeURIComponent(req.id)}`);
  const lines = [
    ...said,
    `**${who}** · ${literal(secret?.label ?? view.title)}`,
    ...(view.said ? [`-# KOS says: “${words(view.said)}”`] : []),
    ...(where || fields ? [`-# ${literal([where, fields].filter(Boolean).join(" · "))}`] : []),
    ...(secret?.warnings ?? []).map((w) => `-# ⚠ ${literal(w)}`),
    ...(view.after ? [`⚠ ${literal(view.after)}`] : []),
    // With no address a phone can open, the way there in words.
    link ? "-# A secret's use is decided on the dashboard or a paired device, never here." : `-# A secret's use is decided on the dashboard or a paired device, never here: the dashboard's Inbox, #${req.id}.`,
    smallPrint(req, view.risk, undefined),
  ];
  return { content: noPreviews(lines.join("\n")).slice(0, CARD_MAX + 100), secret: true };
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}

/** Encode the approve/deny button ids for a pending action. */
export function approvalCustomIds(pendingId: string): { approve: string; deny: string; always: string } {
  return { approve: `${APPROVE_PREFIX}${pendingId}`, deny: `${DENY_PREFIX}${pendingId}`, always: `${ALWAYS_PREFIX}${pendingId}` };
}

/** Decode a button customId back into an approval decision, or null. */
export function parseApprovalCustomId(customId: string): { id: string; approved: boolean; remember?: boolean } | null {
  if (customId.startsWith(ALWAYS_PREFIX)) return { id: customId.slice(ALWAYS_PREFIX.length), approved: true, remember: true };
  if (customId.startsWith(APPROVE_PREFIX)) return { id: customId.slice(APPROVE_PREFIX.length), approved: true };
  if (customId.startsWith(DENY_PREFIX)) return { id: customId.slice(DENY_PREFIX.length), approved: false };
  return null;
}

/**
 * The card's buttons: Approve, Deny, and the remembered yes only where the
 * one rule every surface keeps offers it, in the words of what it keeps. A
 * secret's card has no Approve: a link to the ask on the dashboard instead,
 * where there is an address to link to, and Deny, which is always safe.
 */
export function approvalButtons(req: ApprovalRequest, dashboardUrl?: string): ActionRowBuilder<ButtonBuilder> {
  const ids = approvalCustomIds(req.id);
  const deny = new ButtonBuilder().setCustomId(ids.deny).setLabel("Deny").setStyle(ButtonStyle.Danger);
  if (placesSecret(req)) {
    const link = reachableUrl(dashboardUrl, `#/inbox/${encodeURIComponent(req.id)}`);
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...(link ? [new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(link).setLabel("Decide on the dashboard")] : []),
      deny,
    );
  }
  const always = offersAlways(req) && req.tool ? (viewOf({ ...req, tool: req.tool }).always ?? "Always allow") : undefined;
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(ids.approve).setLabel("Approve").setStyle(ButtonStyle.Success),
    deny,
    ...(always ? [new ButtonBuilder().setCustomId(ids.always).setLabel(cut(always, 80)).setStyle(ButtonStyle.Primary)] : []),
  );
}

/** The one-line summary a settled card keeps of its ask. */
export function askSummary(req: ApprovalRequest): string {
  return req.tool !== undefined ? summarizeAction(req.tool, req.args ?? {}, req.names, req.where, HOST_KEYS) : req.text;
}

/** Who decided and when, for a settled card. */
export interface Decided {
  /** A name for whoever decided: "you", a member's name, "auto mode". */
  by?: string;
  /** When, epoch ms. */
  at?: number;
}

/**
 * What a settled prompt becomes: one small line saying how it went, by whom
 * and when, and what it was. A lapse was nobody's decision.
 */
export function settledText(outcome: ApprovalOutcome | "gone", summary: string | undefined, id: string, already = false, here = false, decided: Decided = {}): string {
  const how = outcome === "approved" ? "✅ Approved" : outcome === "expired" ? "⌛ Lapsed" : outcome === "gone" ? "No longer waiting" : "❌ Denied";
  // Pressed after it was settled: how it went, and where, said as that.
  const mark = !already || outcome === "gone" ? how : here || outcome === "expired" ? `Already decided: ${how}` : `Already decided on the dashboard: ${how}`;
  const by = decided.by && outcome !== "expired" && outcome !== "gone" ? ` by ${literal(decided.by)}` : "";
  const at = decided.at !== undefined && outcome !== "gone" ? ` ${discordTime(decided.at)}` : "";
  const line = `${mark}${by}${at}`;
  if (!summary) return `-# ${line} · #${id}`;
  const { head, body } = splitSummary(summary);
  return noPreviews(`-# ${line} · ${literal(head)}${body ? ` \`${cut(body.replace(/`/g, "'"), 80)}\`` : ""}`);
}
