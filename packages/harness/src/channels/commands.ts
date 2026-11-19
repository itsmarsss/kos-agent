/**
 * Slash commands on Discord, from the one registry every surface shares.
 *
 * None of these reach the model. Each is the command the dashboard's
 * composer runs, sent through the kernel the same way, so it behaves the
 * same wherever it is typed; what Discord adds is a real picker with
 * autocomplete, so the thing being chosen is shown by name while it is
 * chosen, rather than typed blind.
 */

import { ApplicationCommandOptionType, InteractionContextType, type ApplicationCommandDataResolvable } from "discord.js";
import { CHAT_COMMANDS, type CommandSpec } from "@kos/shared";

import type { ApprovalRequest, MessageCard } from "./types.js";

/** Muted blue, so an answer about bookkeeping does not read as an alert. */
const CARD_COLOR = 0x5865f2;

export interface SlashChoice {
  name: string;
  value: string;
}

/** What a command answered, as the kernel says it. */
export interface CommandAnswer {
  reply: string;
  switchedTo?: string;
  opens?: "tools";
}

/** What a command needs from the harness, so this file knows nothing of it. */
export interface SlashContext {
  /** Chats the owner may be sent to, newest first. */
  list(): { id: string; title: string; kind: string }[];
  /** Where this surface currently sends messages. */
  current(): string | undefined;
  /** The surface's own stream. */
  home(): string;
  /** Run a command as typed, in the chat it is meant for, as every surface runs it. */
  run(text: string, conversationId: string): Promise<CommandAnswer>;
  /** Where to read a chat on the dashboard, when it can be reached. */
  link?(conversationId: string): string | undefined;
  /** The scheduled jobs /run can fire, by id. */
  jobs?(): { id: number; name: string; enabled: boolean }[];
  /** What waits on the owner, as its cards draw it. */
  pending?(): ApprovalRequest[];
}

/** The registry's commands a chat surface runs: the dashboard's own stay there. */
export function surfaceCommands(): CommandSpec[] {
  return CHAT_COMMANDS.filter((c) => c.where !== "dashboard");
}

/** A surface's command by the name it was typed as, its own or an alias. */
export function surfaceCommand(name: string): CommandSpec | undefined {
  return surfaceCommands().find((c) => c.name === name || c.aliases?.includes(name));
}

/**
 * The commands as Discord registers them. In the owner's server they are
 * registered for that server, where they show at once, to its
 * administrators alone; in the DM, globally, for DMs only, so the server
 * does not list each one twice.
 */
export function slashCommands(where: "guild" | "dm" | "everywhere"): ApplicationCommandDataResolvable[] {
  // An alias is a command of its own here, as the kernel runs it: `/target` is `/switch`.
  return surfaceCommands().flatMap((c) => [c.name, ...(c.aliases ?? [])].map((name) => ({ ...c, name }))).map((c) => ({
    name: c.name,
    description: c.description.slice(0, 100),
    ...(where === "dm" ? { contexts: [InteractionContextType.BotDM] } : {}),
    // In the server, shown to nobody but its administrators, so a guest is
    // not offered the owner's commands only to be refused them.
    ...(where === "guild" ? { defaultMemberPermissions: 0n } : {}),
    ...(c.option
      ? {
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: c.option.name,
              description: c.option.description.slice(0, 100),
              required: c.option.required === true,
              ...(c.option.choices ? { choices: c.option.choices.map((v) => ({ name: v, value: v })) } : { autocomplete: c.option.pick !== undefined }),
            },
          ],
        }
      : {}),
  })) as ApplicationCommandDataResolvable[];
}

/** The command as the kernel reads it: `/name argument`. */
export function commandText(name: string, argument?: string): string {
  const said = argument?.trim();
  return said ? `/${name} ${said}` : `/${name}`;
}

/** The commands that move where the DM sends, said so when typed in a room, which keeps its own chat. */
const MOVES_DM = new Set(["new", "switch", "target", "here", "fork", "agent", "project", "archive"]);

/** A command's answer as a card, shown to whoever asked alone; `tools` links the chat's tool scope, when it opens one. */
export function commandCard(name: string, answer: CommandAnswer, opts: { room?: boolean; tools?: string } = {}): MessageCard {
  const open = answer.opens === "tools" && opts.tools ? `\n\n[Open the tool scope](${opts.tools})` : "";
  const moved = opts.room && MOVES_DM.has(name) && answer.switchedTo !== undefined;
  return {
    title: `/${name}`,
    body: `${answer.reply.slice(0, 3900)}${open}`,
    color: CARD_COLOR,
    ...(moved ? { footer: "moves your DMs; this channel stays with its own chat" } : {}),
  };
}

/**
 * A chat's name as the picker shows it.
 *
 * Discord will not display a choice longer than a hundred characters, and a
 * title here is the owner's first message, so most of them are longer.
 */
function label(chat: { title: string; kind: string }): string {
  const mark = chat.kind === "surface" ? "# " : chat.kind === "schedule" ? "⏱ " : chat.kind === "project" ? "◆ " : "";
  const name = `${mark}${chat.title}`;
  return name.length > 90 ? `${name.slice(0, 89)}…` : name;
}

/** Chats matching what has been typed so far, for the picker. */
export function completions(ctx: SlashContext, typed: string): SlashChoice[] {
  const needle = typed.trim().toLowerCase();
  return (
    ctx
      .list()
      .filter((c) => !needle || c.title.toLowerCase().includes(needle))
      // Discord shows at most twenty-five.
      .slice(0, 25)
      .map((c) => ({ name: label(c), value: c.id }))
  );
}

/** A job as the /run picker shows it, marked when paused. */
function jobLabel(job: { name: string; enabled: boolean }): string {
  const name = `⏱ ${job.name}${job.enabled ? "" : " (paused)"}`;
  return name.length > 90 ? `${name.slice(0, 89)}…` : name;
}

/** Jobs matching what has been typed, for /run: shown by name, chosen by id. */
export function jobCompletions(ctx: SlashContext, typed: string): SlashChoice[] {
  const needle = typed.trim().toLowerCase();
  return (ctx.jobs?.() ?? [])
    .filter((j) => !needle || j.name.toLowerCase().includes(needle))
    .slice(0, 25)
    .map((j) => ({ name: jobLabel(j), value: String(j.id) }));
}

/** Asks waiting on the owner, for /approve and /deny: shown by what they do, chosen by number. */
export function approvalCompletions(ctx: SlashContext, typed: string, summary: (req: ApprovalRequest) => string): SlashChoice[] {
  const needle = typed.trim().replace(/^#/, "").toLowerCase();
  return (ctx.pending?.() ?? [])
    .map((req) => ({ name: `#${req.id} ${summary(req)}`, value: req.id }))
    .filter((c) => !needle || c.name.toLowerCase().includes(needle))
    .slice(0, 25)
    .map((c) => ({ ...c, name: c.name.length > 90 ? `${c.name.slice(0, 89)}…` : c.name }));
}

/**
 * The job a /run argument names, as an id. The picker hands over the id; a
 * name typed by hand is resolved to its id at once, exactly or by the one
 * job it alone matches, and never kept as a name.
 */
export function jobNamed(ctx: SlashContext, argument: string | undefined): number | undefined {
  const raw = (argument ?? "").trim().replace(/^cron:/, "");
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw);
  const lower = raw.toLowerCase();
  const jobs = ctx.jobs?.() ?? [];
  const exact = jobs.find((j) => j.name.toLowerCase() === lower);
  if (exact) return exact.id;
  const partial = jobs.filter((j) => j.name.toLowerCase().includes(lower));
  return partial.length === 1 ? partial[0]!.id : undefined;
}
