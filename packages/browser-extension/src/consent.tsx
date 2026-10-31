import { LazyMotion, MotionConfig, domMax, m } from "motion/react";
import { useEffect, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

import { Chips, Face, ask, minutesWords, rise, spring, stagger } from "./ui/kit.js";
import type { ConsentRequest } from "./worker.js";

/**
 * The window the extension opens when KOS asks to work in this Chrome:
 * what for, which chat asks (and which KOS, when there are several), and
 * for how long, up to the owner's longest, with Allow and Deny. Closing it,
 * or leaving it the owner's wait, is Deny, and it counts that wait down.
 */

const CHOICES = [5, 15, 30, 60, 120, 240, 480];
const id = new URLSearchParams(location.search).get("id") ?? "";

function Consent(): ReactElement {
  const [request, setRequest] = useState<ConsentRequest | null>();
  const [minutes, setMinutes] = useState(15);
  useEffect(() => {
    void ask<ConsentRequest | null>({ type: "consent.request", id })
      .catch(() => null)
      .then((r) => {
        setRequest(r);
        if (r) setMinutes(r.minutes);
      });
  }, []);
  const decide = async (allowed: boolean): Promise<void> => {
    await chrome.runtime.sendMessage({ type: "consent.answer", id, allowed, minutes });
    window.close();
  };
  if (request === undefined) return <div className="ask" />;
  const choices = request ? [...new Set([...CHOICES.filter((v) => v <= Math.min(request.longest, Math.max(request.minutes, 5))), request.minutes])].sort((a, b) => a - b) : [];
  return (
    <m.div className="ask" variants={stagger} initial="hidden" animate="show">
      <m.div className="halo" initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={spring}>
        <Face size={54} mood="needs-you" />
      </m.div>
      <m.div className="title" variants={rise}>
        <strong>KOS wants to use this Chrome</strong>
        {request && (
          <p className="hint">
            Asked from <strong>{request.requester}</strong>
            {request.kos ? ` on ${request.kos}` : ""}
          </p>
        )}
      </m.div>
      <m.p id="task" className="task-box" variants={rise}>
        {request ? request.task : "This ask has lapsed."}
      </m.p>
      {request && (
        <>
          <m.div className="section" variants={rise}>
            <p className="label">For how long</p>
            <div id="minutes">
              <Chips options={choices.map((v) => [v, minutesWords(v)])} selected={minutes} onChoose={setMinutes} />
            </div>
          </m.div>
          <m.p className="hint" variants={rise}>
            KOS works in a window of its own and in tabs you give it, nowhere else. Click or type in one of its tabs to take over; Stop ends it.
          </m.p>
        </>
      )}
      <m.div className="row" variants={rise}>
        {request && <Countdown waitMs={request.waitMs} />}
        {request ? (
          <>
            <button type="button" id="deny" className="btn" onClick={() => void decide(false)}>
              Deny
            </button>
            <button type="button" id="allow" className="btn btn--primary" autoFocus onClick={() => void decide(true)}>
              Allow
            </button>
          </>
        ) : (
          <button type="button" id="deny" className="btn" onClick={() => window.close()}>
            Close
          </button>
        )}
      </m.div>
    </m.div>
  );
}

/** The seconds until the ask says no by itself, with a bar running down beside them. */
function Countdown({ waitMs }: { waitMs: number }): ReactElement {
  const [opened] = useState(Date.now);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const left = Math.max(0, Math.ceil((waitMs - (now - opened)) / 1000));
  return (
    <span className="count grow">
      <span className="hint">Says no in {left} s</span>
      <span className="count-bar">
        <m.span initial={{ scaleX: 1 }} animate={{ scaleX: 0 }} transition={{ duration: waitMs / 1000, ease: "linear" }} />
      </span>
    </span>
  );
}

createRoot(document.getElementById("root")!).render(
  <LazyMotion features={domMax} strict>
    <MotionConfig reducedMotion="user">
      <Consent />
    </MotionConfig>
  </LazyMotion>,
);
