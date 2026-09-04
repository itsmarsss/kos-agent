import { MESSAGE_LIMITS } from "../channels/types.js";
import type {
  MessageButton,
  MessageCard,
  MessageTarget,
  ModalSpec,
} from "../channels/types.js";
import type { KosModule } from "../modules/loader.js";
import { requireServices } from "../modules/loader.js";

/**
 * The `notify` tool module: say something on the surface the owner is on.
 *
 * This used to be one string to one person. KOS is a bot, and a bot that can
 * only DM its owner in plain text cannot do the ordinary things a bot does:
 * post to the channel a question came from, put a card up that reads as
 * something rather than a wall of text, or offer a button instead of asking
 * the reader to type a reply.
 *
 * Three things are new and each is separately optional, so the plain call is
 * still the plain call:
 *
 * - `to` picks where. Default is the owner, which is the only destination
 *   that needs no permission; anywhere else is a message somewhere the owner
 *   may not be watching, so it escalates to an approval.
 * - `card` is a title, a body and labelled fields, rendered as an embed where
 *   the surface has them and as text where it does not.
 * - `buttons` come back. A press is delivered to a conversation as a message,
 *   so the whole turn machinery answers it, and `replyTo` says which
 *   conversation that is.
 *
 * Every call sends a message. There is no held-for-later shape: a card is a
 * message with a card in it, which is the only reading that survived contact
 * with anyone using it.
 */

/** What a press is delivered to, when the caller does not say. */
export type PressRouter = (
  button: { id: string; label: string },
  replyTo?: string,
) => string;

export interface NotifyPayload {
  text: string;
  target: MessageTarget;
  card?: MessageCard;
  buttons?: MessageButton[];
}

export interface NotifyToolDeps {
  /** Mint the token a press comes back on, and record where it belongs. */
  routePress?: (
    button: {
      id: string;
      label: string;
      modal?: ModalSpec;
      ephemeral?: boolean;
    },
    replyTo?: string,
  ) => string;
}

/** Keys a card is made of. Anything else the caller invented is reported. */
const CARD_KEYS = new Set([
  "title", "body", "url", "color", "footer", "imageUrl", "thumbnailUrl", "fields",
]);

/**
 * Keys on a card that mean nothing here.
 *
 * A card's shape used to be described only in prose, so an agent would write
 * its fields as top-level keys -- {title, Status, Timezone, ...} -- and get
 * back a card with only a title and no sign that the rest had been dropped.
 * Reported rather than silently reshaped: guessing which invented key was
 * meant to be a field is how a typo becomes content.
 */
function strayCardKeys(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null) return [];
  return Object.keys(raw as Record<string, unknown>).filter(
    (key) => !CARD_KEYS.has(key),
  );
}

function asCard(raw: unknown): MessageCard | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const input = raw as Record<string, unknown>;
  const str = (key: string): string | undefined =>
    typeof input[key] === "string" && input[key] !== "" ? (input[key] as string) : undefined;
  const fields = Array.isArray(input.fields)
    ? input.fields.flatMap((f) => {
        if (typeof f !== "object" || f === null) return [];
        const field = f as Record<string, unknown>;
        if (typeof field.name !== "string" || typeof field.value !== "string") return [];
        return [
          {
            name: field.name,
            value: field.value,
            ...(field.inline === true ? { inline: true } : {}),
          },
        ];
      })
    : [];
  const card: MessageCard = {
    ...(str("title") ? { title: str("title")! } : {}),
    ...(str("body") ? { body: str("body")! } : {}),
    ...(str("url") ? { url: str("url")! } : {}),
    ...(typeof input.color === "number" ? { color: input.color } : {}),
    ...(str("footer") ? { footer: str("footer")! } : {}),
    ...(str("imageUrl") ? { imageUrl: str("imageUrl")! } : {}),
    ...(str("thumbnailUrl") ? { thumbnailUrl: str("thumbnailUrl")! } : {}),
    ...(fields.length ? { fields } : {}),
  };
  return Object.keys(card).length ? card : undefined;
}

function asModal(raw: unknown): ModalSpec | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const input = raw as Record<string, unknown>;
  const title = typeof input.title === "string" ? input.title : "";
  const fields = Array.isArray(input.fields)
    ? input.fields.flatMap((f) => {
        if (typeof f !== "object" || f === null) return [];
        const field = f as Record<string, unknown>;
        const id = typeof field.id === "string" ? field.id : "";
        const label = typeof field.label === "string" ? field.label : "";
        if (!id || !label) return [];
        return [
          {
            id,
            label,
            ...(field.style === "paragraph" ? { style: "paragraph" as const } : {}),
            ...(typeof field.placeholder === "string"
              ? { placeholder: field.placeholder }
              : {}),
            ...(field.required === false ? { required: false } : {}),
            ...(typeof field.value === "string" ? { value: field.value } : {}),
            ...(typeof field.maxLength === "number"
              ? { maxLength: field.maxLength }
              : {}),
          },
        ];
      })
    : [];
  if (!fields.length) return undefined;
  return { title: title || "Details", fields };
}

function asButtons(raw: unknown): MessageButton[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((b) => {
    // A bare string is a label and nothing else, which is what an agent
    // writes when it is thinking about the reader rather than the schema.
    // Dropping it left a message whose text promised buttons that were not
    // there.
    if (typeof b === "string") {
      return b.trim() ? [{ label: b.trim() }] : [];
    }
    if (typeof b !== "object" || b === null) return [];
    const button = b as Record<string, unknown>;
    if (typeof button.label !== "string" || !button.label.trim()) return [];
    const style = button.style;
    return [
      {
        label: button.label,
        ...(typeof button.id === "string" && button.id ? { id: button.id } : {}),
        ...(typeof button.url === "string" && button.url ? { url: button.url } : {}),
        ...(style === "primary" || style === "secondary" || style === "success" || style === "danger"
          ? { style }
          : {}),
        ...(asModal(button.modal) ? { modal: asModal(button.modal)! } : {}),
        ...(button.ephemeral === true ? { ephemeral: true } : {}),
      },
    ];
  });
}

/**
 * Where a message is addressed: which surface, and where on it.
 *
 * The first segment names the surface, which is a channel adapter: "discord",
 * and whatever is connected alongside it later. What follows says where on
 * that surface. Both are optional and the common case is neither:
 *
 *   (omitted) | owner        the owner, wherever they already are
 *   discord                  the owner, on Discord specifically
 *   discord:channel:123      that channel on Discord
 *   channel:123              that channel, on whichever surface is wired
 *   user:456                 that person
 *
 * A bare number is refused rather than guessed at: a user id and a channel id
 * look identical, and delivering to the wrong one is a message in public that
 * was meant to be private.
 */
export function parseTarget(raw: unknown): MessageTarget {
  if (raw === undefined || raw === null || raw === "" || raw === "owner") {
    return { kind: "owner" };
  }
  if (typeof raw !== "string") throw new Error("to must be a string");

  const parts = raw.split(":").filter((p) => p !== "");
  const head = parts[0]!;

  // A destination with no surface: whichever one is wired.
  if (head === "channel" || head === "user") {
    const id = parts[1];
    if (!id) throw new Error(`${head} needs an id, as "${head}:<id>"`);
    return { kind: head, id };
  }

  /*
   * Otherwise the head names a surface. It has to look like a name: a bare
   * number is an id someone forgot to say the kind of, and reading it as a
   * surface would turn "send this to 123456789" into a message addressed to
   * nowhere, reported as a success.
   */
  if (!/^[a-z][a-z0-9_-]*$/i.test(head)) {
    throw new Error(
      `unrecognised destination: ${raw}. Use "owner", a surface like "discord", or "channel:<id>" / "user:<id>".`,
    );
  }
  const surface = head;
  if (parts.length === 1 || parts[1] === "owner") return { surface, kind: "owner" };
  const kind = parts[1];
  if (kind !== "channel" && kind !== "user") {
    throw new Error(
      `unrecognised destination: ${raw}. Use "${surface}", "${surface}:channel:<id>" or "${surface}:user:<id>".`,
    );
  }
  const id = parts[2];
  if (!id) throw new Error(`${kind} needs an id, as "${surface}:${kind}:<id>"`);
  return { surface, kind, id };
}

/**
 * True when this call speaks somewhere the owner did not choose.
 *
 * Keyed on whom, never on which surface: a message to the owner asks nothing
 * whether it goes to Discord or anywhere else, and a message to a channel is
 * KOS speaking in public on any surface at all.
 */
export function sendsElsewhere(input: Record<string, unknown>): boolean {
  try {
    return parseTarget(input.to).kind !== "owner";
  } catch {
    // A destination that does not parse fails in the tool with a message
    // saying so. Treating it as risky here would ask for approval first.
    return false;
  }
}

/**
 * What a message reads as where there is no card: the title, then the body,
 * then the text. Used by any surface that has only prose, including the
 * dashboard notice a message falls back to when no channel is wired.
 */
export function noticeText(payload: NotifyPayload): string {
  const parts = [payload.text];
  const card = payload.card;
  if (card) {
    if (card.title) parts.push(`**${card.title}**`);
    if (card.body) parts.push(card.body);
    for (const field of card.fields ?? []) parts.push(`${field.name}: ${field.value}`);
    if (card.footer) parts.push(card.footer);
  }
  return parts.filter(Boolean).join("\n\n");
}

/**
 * What the call did, in the words the agent will act on.
 *
 * "sent" was the whole result, which says nothing about where it went, what
 * it carried, or what comes back. An agent that cannot tell a delivered
 * message from a held one, or a button that answers from a link that does
 * not, guesses -- and it guessed wrong the first time anyone watched.
 */
export function describeSend(args: {
  target: MessageTarget;
  text: string;
  card?: MessageCard;
  buttons: MessageButton[];
  landsIn?: string;
  stray: string[];
}): string {
  const { target, card, buttons } = args;

  const where = `Sent to ${
    target.kind === "owner" ? "the owner" : `${target.kind} ${target.id}`
  }${target.surface ? ` on ${target.surface}` : ""}.`;

  const carried: string[] = [];
  if (args.text) carried.push("text");
  if (card) {
    const fields = card.fields?.length ?? 0;
    carried.push(
      fields ? `a card with ${fields} field${fields === 1 ? "" : "s"}` : "a card",
    );
  }
  if (buttons.length) {
    carried.push(`${buttons.length} button${buttons.length === 1 ? "" : "s"}`);
  }

  const notes: string[] = [];
  const pressable = buttons.filter((b) => !b.url);
  if (pressable.length) {
    notes.push(
      `Presses arrive as a message${args.landsIn ? ` in ${args.landsIn}` : ""}; your answer goes back to whoever pressed.`,
    );
    const forms = pressable.filter((b) => b.modal);
    if (forms.length) {
      notes.push(
        `Opens a form: ${forms.map((b) => `"${b.label}"`).join(", ")}.`,
      );
    }
    const priv = pressable.filter((b) => b.ephemeral);
    if (priv.length) {
      notes.push(
        `Answers privately: ${priv.map((b) => `"${b.label}"`).join(", ")}.`,
      );
    }
  }
  if (buttons.some((b) => b.url)) {
    notes.push("Link buttons send nothing back.");
  }

  // What will not survive the surface, said here rather than discovered by
  // the reader seeing a form with its last box missing.
  if (buttons.length > MESSAGE_LIMITS.buttons) {
    notes.push(
      `Only the first ${MESSAGE_LIMITS.buttons} buttons are shown; the rest were dropped.`,
    );
  }
  for (const button of buttons) {
    const fields = button.modal?.fields.length ?? 0;
    if (fields > MESSAGE_LIMITS.modalFields) {
      notes.push(
        `The form on "${button.label}" has ${fields} boxes and only the first ${MESSAGE_LIMITS.modalFields} are shown.`,
      );
    }
  }
  if (args.stray.length) {
    notes.push(
      `Ignored on the card: ${args.stray.join(", ")}. Named values go in fields: [{name, value}].`,
    );
  }

  return [where, carried.length ? `Carrying ${carried.join(", ")}.` : "", ...notes]
    .filter(Boolean)
    .join(" ");
}

export function createNotifyModule(deps: NotifyToolDeps = {}): KosModule {
  return {
    manifest: {
      name: "notify",
      version: "2.0.0",
      provides: [{ kind: "tool", name: "notify", version: "2.0.0" }],
      riskTier: "safe",
    },
    activate(ctx) {
      const services = requireServices(ctx);
      ctx.registerTool(
        {
          name: "notify",
          description:
            "Send a message on the owner's messaging surface. Plain text by default. " +
            "Add `card` for a titled block with fields, and `buttons` for something to " +
            "press. `to` picks the surface and where on it: omit for the owner wherever " +
            'they already are, "discord" for the owner on Discord, "discord:channel:<id>" ' +
            "to post in a channel, which needs approval. A press comes back as a message " +
            "in the conversation named by `replyTo`, so say what a button means in its " +
            "label.",
          inputSchema: {
            type: "object",
            properties: {
              text: { type: "string" },
              to: {
                type: "string",
                description:
                  'owner (default), reply (make this the shape of the answer you are about to give, rather than a second message), channel:<id>, or user:<id>',
              },
              card: {
                type: "object",
                description:
                  "A titled block. Named values go in fields, not as keys of their own.",
                properties: {
                  title: { type: "string" },
                  body: { type: "string" },
                  url: { type: "string" },
                  color: { type: "number", description: "0xRRGGBB" },
                  footer: { type: "string" },
                  imageUrl: { type: "string" },
                  thumbnailUrl: { type: "string" },
                  fields: {
                    type: "array",
                    description: "the named values, in order",
                    items: {
                      type: "object",
                      properties: {
                        name: { type: "string" },
                        value: { type: "string" },
                        inline: { type: "boolean" },
                      },
                      required: ["name", "value"],
                    },
                  },
                },
              },
              buttons: {
                type: "array",
                description:
                  "Something to press. A label alone is enough; a url makes it a link, which nothing comes back from. A modal opens a form first and sends what was typed. The press, and anything typed, comes back to you as a message and your answer goes to whoever pressed it.",
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string" },
                    id: { type: "string" },
                    url: { type: "string" },
                    style: {
                      type: "string",
                      enum: ["primary", "secondary", "success", "danger"],
                    },
                    ephemeral: {
                      type: "boolean",
                      description:
                        "the answer to this press is shown only to whoever pressed it",
                    },
                    modal: {
                      type: "object",
                      description:
                        "open a form on press and send what was typed, for an answer that is not one of a fixed few",
                      properties: {
                        title: { type: "string" },
                        fields: {
                          type: "array",
                          description: "at most five",
                          items: {
                            type: "object",
                            properties: {
                              id: {
                                type: "string",
                                description: "name the answer comes back under",
                              },
                              label: { type: "string" },
                              style: {
                                type: "string",
                                enum: ["short", "paragraph"],
                              },
                              placeholder: { type: "string" },
                              required: { type: "boolean" },
                              value: { type: "string", description: "prefilled" },
                              maxLength: { type: "number" },
                            },
                            required: ["id", "label"],
                          },
                        },
                      },
                      required: ["title", "fields"],
                    },
                  },
                  required: ["label"],
                },
              },
              replyTo: {
                type: "string",
                description:
                  "conversation a press is delivered to; defaults to this one",
              },
            },
            required: ["text"],
          },
        },
        async (input) => {
          const text = typeof input.text === "string" ? input.text : "";
          const card = asCard(input.card);
          if (!text && !card) throw new Error("notify requires text or a card");
          if (!services.notify) throw new Error("no notify channel is wired");

          const target = parseTarget(input.to);
          const replyTo = typeof input.replyTo === "string" ? input.replyTo : undefined;
          const buttons = asButtons(input.buttons).map((button) => {
            if (button.url) return button;
            if (!deps.routePress) {
              throw new Error(
                "this surface cannot take a button back, so send a link or ask in the text",
              );
            }
            return {
              ...button,
              token: deps.routePress(
                {
                  id: button.id ?? button.label,
                  label: button.label,
                  ...(button.modal ? { modal: button.modal } : {}),
                  ...(button.ephemeral ? { ephemeral: true } : {}),
                },
                replyTo,
              ),
            };
          });

          await services.notify({
            text,
            target,
            ...(card ? { card } : {}),
            ...(buttons.length ? { buttons } : {}),
          });

          return describeSend({
            target,
            text,
            ...(card ? { card } : {}),
            buttons,
            ...(replyTo ? { landsIn: replyTo } : {}),
            stray: strayCardKeys(input.card),
          });
        },
        {
          floor: "safe",
          // Messaging the owner is the whole point and asks nothing. Posting
          // anywhere else is KOS speaking in a place the owner did not choose,
          // which is a decision for the owner rather than for the agent.
          escalate: sendsElsewhere,
        },
      );
    },
  };
}

/** The plain module, for a host that wires no press routing. */
export const notifyModule: KosModule = createNotifyModule();
