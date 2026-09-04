import type {
  ButtonPress,
  ButtonPressHandler,
  PressResponder,
} from "../channels/types.js";
import type { Kernel } from "./kernel.js";

/**
 * What happens when someone presses a button KOS sent.
 *
 * A press is a message from a person, so it runs a turn in the conversation
 * the button came from and the answer goes back to whoever pressed. That is
 * the whole idea; the care is in the order, which the surface dictates:
 *
 * - The form first, if the button opens one. A surface will not show a form
 *   once the interaction has been acknowledged any other way.
 * - Then say the work has started, because a turn takes longer than a surface
 *   will hold someone on a spinner.
 * - Then the answer.
 *
 * This lived in the host, where nothing could test it, and had two defects in
 * as many days: the answer was discarded entirely, and then it was asked for
 * without saying which surface it was going to, so a card came back as prose.
 */

export interface PressHandlerDeps {
  kernel: Kernel;
  /**
   * The surface the press came from.
   *
   * Load-bearing rather than decorative: a turn that does not say where its
   * answer is going gets a card folded into text, which reaches the reader as
   * an embed spelled out in words.
   */
  channel: string;
  /** The owner's id on that surface, so a press by them reads as "you". */
  ownerRecipientId?: string;
}

/** How a press is described to the agent: who, which button, what they typed. */
export function pressMessage(
  press: ButtonPress,
  route: { label: string; buttonId: string },
  values: Record<string, string> | undefined,
  ownerRecipientId?: string,
): string {
  const who =
    ownerRecipientId && press.pressedBy === ownerRecipientId
      ? "you"
      : press.pressedBy;
  const named =
    route.buttonId && route.buttonId !== route.label ? ` (${route.buttonId})` : "";
  const typed = Object.entries(values ?? {}).filter(([, v]) => v !== "");
  return [
    `[${who} pressed "${route.label}"${named}]`,
    ...typed.map(([name, value]) => `${name}: ${value}`),
  ].join("\n");
}

export function createPressHandler(deps: PressHandlerDeps): ButtonPressHandler {
  return async (press: ButtonPress, respond: PressResponder): Promise<void> => {
    const route = deps.kernel.presses.get(press.token);
    if (!route) {
      await respond.send({
        text: "That button is from a message too old to still be live.",
      });
      return;
    }

    let filled: Record<string, string> | undefined;
    if (route.modal) {
      filled = await respond.openForm(route.modal);
      // Closed, or left open too long. Someone deciding not to answer is not
      // a turn to run on nothing.
      if (!filled) return;
    }

    await respond.working({ ...(route.ephemeral ? { ephemeral: true } : {}) });

    const res = await deps.kernel.handleMessage(
      pressMessage(press, route, filled, deps.ownerRecipientId),
      {
        sessionId: route.conversationId,
        origin: "system",
        // Which surface the answer is for. Without it the turn cannot know a
        // card will be rendered, so it sends the words instead.
        channel: deps.channel,
      },
    );

    await respond.send({
      text: res.reply,
      ...(res.card ? { card: res.card } : {}),
      ...(res.buttons?.length ? { buttons: res.buttons } : {}),
    });
  };
}
