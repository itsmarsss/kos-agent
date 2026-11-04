import { COLOURS, RADII, TYPE, type HtmlPage } from "@kos/shared";
import kitCss from "@kos/kit/kit.css?raw";
import pageCss from "@kos/kit/page.css?raw";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import { api, type PageSummary } from "../api.js";
import { pageDocument, tokenRule } from "./artifactdoc.js";

/**
 * An HTML page, the way a Claude artifact is shown: the agent's document in a
 * frame of its own, sandboxed to scripts only. Without allow-same-origin the
 * frame is an opaque origin, so it cannot reach the dashboard's DOM, storage,
 * cookies or token; its policy allows no network. Its one way out is
 * window.kos, which this relays to the server, where each call is checked
 * against what the page declared. This side only answers its own frame, asks
 * the owner before a page speaks to the chat, and stops a page that navigates
 * away.
 */

const CSS = `${kitCss}\n${pageCss}`;

/** Every token the page's stylesheets read, and the ones a page is told it may use. */
const TOKEN_NAMES = [
  ...new Set([
    ...Object.keys(COLOURS).map((t) => `--${t}`),
    ...Object.keys(RADII).map((r) => `--r-${r}`),
    ...Object.keys(TYPE).map((t) => `--text-${t}`),
    "--mono",
    ...[...CSS.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]!),
  ]),
];

function currentTokens(): { tokens: Record<string, string>; mode: "light" | "dark" } {
  const style = getComputedStyle(document.documentElement);
  const tokens: Record<string, string> = {};
  for (const name of TOKEN_NAMES) {
    const value = style.getPropertyValue(name).trim();
    if (value) tokens[name] = value;
  }
  const mode = style.colorScheme.includes("light") && !style.colorScheme.includes("dark") ? "light" : "dark";
  return { tokens, mode };
}

/** The libraries a page names, fetched once from KOS's own build and kept. */
const fetched = new Map<string, Promise<string>>();
function library(name: string): Promise<string> {
  let got = fetched.get(name);
  if (!got) {
    got = fetch(`/page-lib/${name}.js`).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`library ${name} is missing from this build`))));
    fetched.set(name, got);
  }
  return got;
}

interface Asked {
  text: string;
  answer: (sent: boolean) => void;
}

export interface ArtifactPageProps {
  record: PageSummary;
  page: HtmlPage;
}

export function ArtifactPage({ record, page }: ArtifactPageProps): ReactElement {
  const frame = useRef<HTMLIFrameElement>(null);
  const loads = useRef(0);
  const [doc, setDoc] = useState<string>();
  const [error, setError] = useState<string>();
  const [left, setLeft] = useState(false);
  const [asked, setAsked] = useState<Asked>();
  const [told, setTold] = useState<string>();
  const chat = `project:${record.projectSlug}`;

  // The document, once the libraries it names are here. A new page, or a new version of it, starts over.
  useEffect(() => {
    let stale = false;
    loads.current = 0;
    setLeft(false);
    setError(undefined);
    setDoc(undefined);
    void Promise.all((page.libraries ?? []).map(library))
      .then((libraries) => {
        if (!stale) setDoc(pageDocument({ html: page.html, css: CSS, libraries, ...currentTokens() }));
      })
      .catch((err: unknown) => !stale && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      stale = true;
    };
  }, [page, record.updatedAt]);

  const reply = useCallback((id: unknown, body: { result?: unknown; error?: string }) => {
    frame.current?.contentWindow?.postMessage({ __kos: "reply", id, ...body }, "*");
  }, []);

  useEffect(() => {
    const heard = (e: MessageEvent): void => {
      // Its own frame only, and only while it is still the page KOS gave it.
      if (!frame.current || e.source !== frame.current.contentWindow || left) return;
      const m = (e.data ?? {}) as { __kos?: string; id?: unknown; method?: string; args?: Record<string, unknown>; message?: string };
      if (m.__kos === "error") {
        setError((current) => current ?? String(m.message ?? "The page hit an error"));
        return;
      }
      if (m.__kos !== "call") return;
      const args = m.args ?? {};
      if (m.method === "ask") {
        if (!page.capabilities?.ask) return reply(m.id, { error: "this page does not declare ask" });
        const text = String(args.text ?? "").slice(0, 4000);
        setAsked({ text, answer: (sent) => reply(m.id, sent ? { result: { sent: true } } : { error: "the owner did not send it" }) });
        return;
      }
      const verb = m.method === "query" ? "query" : m.method === "write" ? "write" : m.method === "file" ? "file" : undefined;
      if (!verb) return reply(m.id, { error: `kos has no ${String(m.method)}` });
      api.pageCall(record.id, verb, args).then(
        (result) => reply(m.id, { result }),
        (err: unknown) => reply(m.id, { error: err instanceof Error ? err.message : String(err) }),
      );
    };
    window.addEventListener("message", heard);
    return () => window.removeEventListener("message", heard);
  }, [left, page.capabilities?.ask, record.id, reply]);

  // The dashboard's theme, followed: the page is told, and its tokens change with it.
  useEffect(() => {
    const tell = (): void => {
      const { tokens, mode } = currentTokens();
      frame.current?.contentWindow?.postMessage({ __kos: "theme", mode, rule: tokenRule(tokens, mode) }, "*");
    };
    const watch = new MutationObserver(tell);
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", tell);
    return () => {
      watch.disconnect();
      media.removeEventListener("change", tell);
    };
  }, []);

  const send = useCallback(
    (text: string) => {
      void api.message(text, chat).catch(() => undefined);
      setTold("Sent to the project's chat.");
    },
    [chat],
  );

  const frameTitle = useMemo(() => page.title || record.title, [page.title, record.title]);

  return (
    <div className="artifact">
      {asked && (
        <div className="artifact-ask" role="dialog" aria-label="The page asks to message the chat">
          <p>
            This page wants to send this to the project's chat:
          </p>
          <blockquote>{asked.text}</blockquote>
          <div className="artifact-ask-acts">
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => {
                send(asked.text);
                asked.answer(true);
                setAsked(undefined);
              }}
            >
              Send
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                asked.answer(false);
                setAsked(undefined);
              }}
            >
              Don't send
            </button>
          </div>
        </div>
      )}
      {(error || left) && (
        <div className="ops-alert ops-alert--err artifact-error" role="alert">
          <span>{left ? "This page tried to leave KOS, so it was stopped." : `The page hit an error: ${error}`}</span>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() =>
              send(
                `The page "${frameTitle}" (${record.id}) ${left ? "tried to navigate its frame away, which KOS stops" : `shows this error: ${error}`}. Read it with pages.get, fix it, and write it again with pages.write.`,
              )
            }
          >
            Fix with KOS
          </button>
        </div>
      )}
      {told && <p className="hint">{told}</p>}
      {doc !== undefined && !left && (
        <iframe
          ref={frame}
          className="artifact-frame"
          title={frameTitle}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={doc}
          onLoad={() => {
            // The first load is the page; any after it is the frame being sent elsewhere.
            loads.current += 1;
            if (loads.current > 1) setLeft(true);
          }}
        />
      )}
    </div>
  );
}
