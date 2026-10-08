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
