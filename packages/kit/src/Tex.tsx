import { useLayoutEffect, useRef, type ReactElement } from "react";

type Katex = typeof import("katex").default;

let loading: Promise<Katex> | undefined;

/** The largest rule or space a formula may ask for, in em, and how many macro expansions it may make. */
const MAX_SIZE_EM = 10;
const MAX_EXPAND = 200;

/**
 * KaTeX, fetched the first time something on the page has math in it. Its
 * stylesheet is the app's to load (the dashboard imports it, KOS for Chrome
 * links it), so the kit asks nothing of either app's bundler.
 */
function katex(): Promise<Katex> {
  return (loading ??= import("katex").then((m) => m.default));
}

/**
 * A formula, typeset. KaTeX builds it as DOM nodes (render, not
 * renderToString), so the source is never parsed as markup, and with trust
 * off a formula cannot carry a link, a class or a picture. A formula KaTeX
 * cannot read is shown as written, in its error colour. Until KaTeX has
 * loaded, the source stands in. Sizes and macro expansion are capped, and
 * the formula paints only inside its own box (kit.css), so model output
 * cannot draw a rule or a raised word over the chat or an approval card.
 */
export function Tex({ source, display = false }: { source: string; display?: boolean }): ReactElement {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let live = true;
    el.textContent = source;
    void katex().then((k) => {
      if (live) k.render(source, el, { displayMode: display, throwOnError: false, trust: false, strict: "ignore", maxSize: MAX_SIZE_EM, maxExpand: MAX_EXPAND });
    });
    return () => {
      live = false;
    };
  }, [source, display]);
  return <span ref={ref} className={display ? "md-math md-math--display" : "md-math"} />;
}
