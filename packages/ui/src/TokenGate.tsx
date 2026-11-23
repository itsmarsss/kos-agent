import { Field, Pill } from "@kos/kit";
import { Fragment, useEffect, useState, type ReactElement, type ReactNode } from "react";

import { dashboardToken, kosFetch, onUnauthorized, setDashboardToken } from "./api.js";

/**
 * The dashboard token, held by this tab: KOS set up with KOS_DASHBOARD_TOKEN
 * (in the container, where every change needs it) asks for it, and this tab
 * sends it with every request. Kept for the tab's life, never written to disk.
 */
export function DashboardTokenField({ onHeld }: { onHeld?: () => void }): ReactElement {
  const [token, setToken] = useState(dashboardToken() ?? "");
  const [held, setHeld] = useState(dashboardToken() !== undefined);
  return (
    <Field group className="set-field" label="Sign this browser in" hint="Only when a dashboard token is set under Providers: type it here, and this tab sends it with each request and forgets it when the tab closes." badge={held ? <Pill tone="ok">held</Pill> : null}>
      <form
        className="set-token"
        onSubmit={(e) => {
          e.preventDefault();
          setDashboardToken(token);
          setHeld(token.trim() !== "");
          onHeld?.();
        }}
      >
        <input className="kos-input" type="password" autoComplete="off" value={token} placeholder="not set" onChange={(e) => setToken(e.target.value)} />
        <button type="submit" className="btn btn--sm">
          {token.trim() ? "Hold" : "Forget"}
        </button>
      </form>
    </Field>
  );
}

type Gate = "checking" | "open" | "locked";

/**
 * Nothing of the dashboard until KOS takes this tab: a KOS that asks for a
 * token answers 401 to everything, so the prompt for it comes first, and
 * again whenever a request is refused for want of it. Once held, the app
 * starts over so every page loads with it.
 */
export function TokenGate({ children }: { children: ReactNode }): ReactElement | null {
  const [gate, setGate] = useState<Gate>("checking");
  const [tries, setTries] = useState(0);
  useEffect(() => onUnauthorized(() => setGate("locked")), []);
  useEffect(() => {
    if (gate !== "checking") return;
    let live = true;
    // KOS not reachable is the app's to say, not the gate's.
    void kosFetch("/api/health").then(
      (res) => live && setGate(res.status === 401 ? "locked" : "open"),
      () => live && setGate("open"),
    );
    return () => {
      live = false;
    };
  }, [gate]);
  if (gate === "checking") return null;
  if (gate === "locked") {
    return (
      <main className="token-gate">
        <div className="token-gate__card">
          <h1 className="token-gate__title">KOS asks for its token</h1>
          <p className="hint">{tries > 0 && dashboardToken() ? "KOS did not take that token. Check KOS_DASHBOARD_TOKEN and try again." : "This KOS was started with KOS_DASHBOARD_TOKEN. Enter it to open the dashboard."}</p>
          <DashboardTokenField
            onHeld={() => {
              setTries((n) => n + 1);
              setGate("checking");
            }}
          />
        </div>
      </main>
    );
  }
  return <Fragment key={tries}>{children}</Fragment>;
}
