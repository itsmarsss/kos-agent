import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Which conversation is making the current tool call.
 *
 * Turns run concurrently, one lane per conversation, so a single mutable
 * "current conversation" on the kernel is whichever turn started last. A tool
 * that reads it to learn its caller can be told the wrong one: an aside running
 * beside an orchestrator turn took credit for that turn's congregation roster.
 *
 * The toolbox enters this store around each handler it runs, so anything that
 * asks during the call, or in the promise chain the call started, sees the
 * conversation that actually made it. It is a leaf module so the kernel and
 * the toolbox can both import it without a cycle.
 */
export const caller = new AsyncLocalStorage<string>();

/**
 * The model's id for the tool call being executed, where the engine has
 * one. A picture of the browser taken after a step is keyed to it, so the
 * transcript can put the picture under the right card.
 */
export const toolUse = new AsyncLocalStorage<string>();

/**
 * Whether the owner started the turn making the current call.
 *
 * Their own message is attended. A schedule, a blob's own timer, a guest in
 * a channel are not: nobody who could answer a prompt asked for the work.
 * A tool that reaches past the workspace (a computer) reads it to refuse
 * work nobody is watching unless the owner allowed that.
 */
export const attendance = new AsyncLocalStorage<boolean>();

/** True unless the current call is part of a turn the owner did not start. */
export function isAttended(): boolean {
  return attendance.getStore() ?? true;
}

/**
 * Whether the current call is part of the owner's own turn: their own
 * message, on the dashboard or a surface they speak on, and nothing else.
 * Not a schedule's run, a guest's words, a resumed approval, or work another
 * chat passed on, whoever that chat was talking to: what only the owner's
 * turns reach (a blob's artifacts from a root chat) is not laundered through
 * a dispatch. False outside a turn, so a caller that forgets to say is not
 * taken for the owner.
 */
export const ownership = new AsyncLocalStorage<boolean>();

/** True only inside a call of the owner's own turn. */
export function isOwnerTurn(): boolean {
  return ownership.getStore() ?? false;
}

/**
 * Where the turn making the current call came from: the surface its words
 * arrived on ("chrome" for KOS for Chrome's side panel, "mac" for the KOS
 * for Mac window) and those words. A tool that starts something on the
 * owner's own device unasked reads it, so only the owner's words said there
 * do: not a turn typed into the same chat on the dashboard, a dispatch, a
 * schedule or a resumed approval. Absent outside a turn a surface carried.
 */
export interface TurnOrigin {
  surface: string;
  said: string;
}

export const origin = new AsyncLocalStorage<TurnOrigin>();

/** The surface and words of the turn making the current call, when a surface carried it. */
export function turnOrigin(): TurnOrigin | undefined {
  return origin.getStore();
}

/**
 * The owner's own words, when the current call's turn is them speaking on
 * `surface` and nothing else: the one turn that may start a session on that
 * device without a tool asking for it. Undefined for every other turn.
 */
export function ownWordsOn(surface: string): string | undefined {
  const from = origin.getStore();
  return isOwnerTurn() && isAttended() && from?.surface === surface ? from.said : undefined;
}

/**
 * Which turn is making the current call, beside its conversation. A chat can
 * have two turns alive at once (one suspended on an approval, one answering
 * the next message), and what a turn may reach can belong to that turn alone.
 */
export const turn = new AsyncLocalStorage<string>();

/**
 * The stop of the turn making the current call. A tool that runs something
 * which outlives a promise (a child process) ends it when this aborts, so
 * pressing Stop leaves nothing running behind the turn.
 */
export const turnStop = new AsyncLocalStorage<AbortSignal>();

/**
 * The one site the current call was allowed on without asking, when it was
 * allowed by site (a session's "this site" or an "Always on this site"
 * rule): a run of steps checks it before each, so it cannot carry the yes
 * to another site part way.
 */
export const onSite = new AsyncLocalStorage<string>();
