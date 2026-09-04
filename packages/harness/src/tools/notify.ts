import type { MessageButton, MessageCard, MessageTarget } from "../channels/types.js";
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
  routePress?: (button: { id: string; label: string }, replyTo?: string) => string;
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
      },
    ];
  });
}

/**
 * Where a message is addressed.
 *
 * "owner" and an absent `to` are the same thing. A bare id is refused rather
 * than guessed at: a user id and a channel id look identical, and delivering
 * to the wrong one is a message in public that was meant to be private.
 */
export function parseTarget(raw: unknown): MessageTarget {
  if (raw === undefined || raw === null || raw === "" || raw === "owner") {
    return { kind: "owner" };
  }
  if (raw === "reply") return { kind: "reply" };
  if (typeof raw !== "string") throw new Error("to must be a string");
  const [kind, id] = raw.split(":", 2);
  if ((kind === "channel" || kind === "user") && id) return { kind, id };
  throw new Error(
    `unrecognised destination: ${raw}. Use "owner", "channel:<id>" or "user:<id>".`,
  );
}

/**
 * True when this call speaks somewhere the owner did not choose.
 *
 * "reply" is not one of those: it is the answer to the message being handled,
 * going to whoever is already being spoken to. Asking permission to answer
 * would make a card cost an approval and a paragraph cost nothing, which
 * would teach the agent to never use one.
 */
export function sendsElsewhere(input: Record<string, unknown>): boolean {
  try {
    const kind = parseTarget(input.to).kind;
    return kind !== "owner" && kind !== "reply";
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
            'Add `card` for a titled block with fields, `buttons` for something to press, ' +
            'and `to` to post somewhere other than the owner ("channel:<id>" or "user:<id>"), ' +
            'which needs approval. Use `to: "reply"` to give this turn\'s answer a card or ' +
            "buttons rather than sending a second message alongside it. A press comes back " +
            "as a message in the conversation named by `replyTo`, so say what a button " +
            "means in its label.",
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
                  "Something to press. A label alone is enough; a url makes it a link, which nothing comes back from.",
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
                { id: button.id ?? button.label, label: button.label },
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

          const stray = strayCardKeys(input.card);
          const warning = stray.length
            ? ` Ignored on the card: ${stray.join(", ")}. Named values go in fields: [{name, value}].`
            : "";

          /*
           * What actually happened, because the model acts on this line.
           *
           * "sent" was returned for every target including reply, where
           * nothing is sent: the shape is held for the answer. Told its
           * message had gone, the model had nothing left to say and finished
           * the turn with "I do not have anything to add to that" -- so the
           * card arrived under a sentence saying there was nothing to add.
           */
          if (target.kind === "reply") {
            return (
              "Held for your reply. Nothing has been sent yet: this is the shape of " +
              "the answer you are about to write, and your reply text is the message " +
              "it sits under. Write that answer now." +
              warning
            );
          }
          return `sent${warning}`;
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
