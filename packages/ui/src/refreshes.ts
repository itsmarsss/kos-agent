/**
 * The dashboard's refreshes, in order: a poll that stalls must not land
 * after a later refresh (decide's, say) and bring back what that one had
 * already cleared, and a timer's tick does not pile another on one still out.
 */
export class Refreshes {
  private latest = 0;
  private out = 0;

  /** Whether a refresh is still out: a timer's tick skips its turn then. */
  get busy(): boolean {
    return this.out > 0;
  }

  /** A refresh begun. `newest()` says whether its answers may still be applied; `end()` once it is done, applied or not. */
  begin(): { newest: () => boolean; end: () => void } {
    const mine = ++this.latest;
    this.out += 1;
    let ended = false;
    return {
      newest: () => mine === this.latest,
      end: () => {
        if (ended) return;
        ended = true;
        this.out -= 1;
      },
    };
  }
}
