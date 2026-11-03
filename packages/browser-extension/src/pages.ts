/** What the extension's pages share that is theirs alone: asking the worker, and minutes in words. */

/** Ask the worker; its answer or its refusal. */
export async function ask<T>(message: Record<string, unknown>): Promise<T> {
  const answer = (await chrome.runtime.sendMessage(message)) as { ok: boolean; value?: T; error?: string };
  if (!answer?.ok) throw new Error(answer?.error ?? "the extension did not answer");
  return answer.value as T;
}

export const minutesWords = (m: number): string => (m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} h ${m % 60}` : `${m / 60} h`);

export function minutesLeft(until: number, now = Date.now()): string {
  const left = Math.max(0, Math.ceil((until - now) / 60_000));
  return left <= 1 ? "under a minute left" : `${minutesWords(left)} left`;
}
