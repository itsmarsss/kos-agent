import { useEffect, useState, type KeyboardEvent, type ReactElement, type ReactNode } from "react";

import { registrableDomain, secretFieldWords, type AskSecret, type AskView, type StepLine } from "@kos/shared";

import { CheckIcon, ChevronDown, ChevronRight, CopyIcon, GlobeIcon, HiddenIcon, MailIcon, PageIcon, ServerIcon, WindowIcon } from "./icons.js";
import { Collapse, Countdown, Tag } from "./kit.js";
import { useOverlayScroll } from "./OverlayScroll.js";
import { Tooltip } from "./Tooltip.js";

/**
 * An approval, as every web surface asks it: what KOS wants to do, where,
 * each action it takes with its keys as keycaps, why it asks, then the
 * arguments folded under Details, and Deny, the remembered yes and Approve,
 * one height, under it all. Focused, Enter approves and Escape or
 * ⌘⌫ denies. The dashboard's Inbox, Home, chat and builds and KOS for
 * Chrome's side panel all draw this one (docs/components.md).
 */
export interface AskCardProps {
  /** The ask laid out (askView, or as the host sent it). */
  view: AskView;
  tool: string;
  /** The arguments, for Details: an object, JSON, or text cut to fit. */
  args?: string | Record<string, unknown> | undefined;
  /** What the agent said just before it asked. */
  why?: string | null | undefined;
  /** Who asks, by the name the owner knows the chat by. */
  asker?: string | undefined;
  /** When it lapses if nobody decides, epoch ms. */
  expiresAt?: number | undefined;
  /** A decision is on its way: the pressed button says so and none takes another press. */
  busy?: boolean;
  onDecide: (approved: boolean, remember?: boolean) => void;
  /** What yes and no are called when Approve and Deny are not the words: Done and Can't for a handoff. */
  labels?: { yes: string; no: string };
  /** No remembered yes, whatever the view offers: an ask that is its own each time. */
  noRemember?: boolean;
  /** Smaller type and buttons, for a dense list. */
  compact?: boolean;
  /** No box of its own, for a card drawn inside another (a tool call, a list's row). */
  bare?: boolean;
  /** A quiet line at the foot: when it was asked, a way to its chat. */
  meta?: ReactNode;
  /** A button before the decision's own: Open the browser. */
  extra?: ReactNode;
  /** Under the steps: a picture of what it would act on. */
  children?: ReactNode;
}

export function AskCard({ view, tool, args, why, asker, expiresAt, busy = false, onDecide, labels, noRemember = false, compact = false, bare = false, meta, extra, children }: AskCardProps): ReactElement {
  const [pressed, setPressed] = useState<"yes" | "always" | "no" | null>(null);
  useEffect(() => {
    if (!busy) setPressed(null);
  }, [busy]);
  const decide = (which: "yes" | "always" | "no"): void => {
    // One decision per card: a second press, or a key held down, sends nothing more.
    if (busy || pressed) return;
    setPressed(which);
    if (which === "no") onDecide(false);
    else if (which === "always") onDecide(true, true);
    else onDecide(true);
  };
  /**
   * The card's keys, heard only on the card itself, never on a button or
   * field inside it, and never as a key held down. Enter approves only when
   * the focus came by the keyboard (:focus-visible), so a click on the card
   * and a stray Enter is not a yes.
   */
  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (busy || e.repeat || e.target !== e.currentTarget) return;
    if (e.key === "Enter") {
      if (tooLong || !keyboardFocused(e.currentTarget)) return;
      e.preventDefault();
      decide("yes");
    } else if (e.key === "Escape" || (e.key === "Backspace" && (e.metaKey || e.ctrlKey))) {
      e.preventDefault();
      e.stopPropagation();
      decide("no");
    }
  };
  // Too big for this surface to have been sent whole: no yes here, only a no and the way to the dashboard.
  const tooLong = view.tooLong === true;
  const always = noRemember || tooLong ? undefined : view.always;
  const size = compact ? " btn--sm" : "";
  const working = (which: "yes" | "always" | "no", words: string): ReactNode =>
    busy && pressed === which ? (
      <>
        <Spinner />
        Working
      </>
    ) : (
      words
    );

  return (
    <section
      className={`kos-ask${compact ? " kos-ask--compact" : ""}${bare ? " kos-ask--bare" : ""}`}
      tabIndex={0}
      aria-label={`${asker ?? "KOS"} asks: ${view.title}`}
      aria-keyshortcuts="Enter Escape Meta+Backspace"
      onKeyDown={onKeyDown}
    >
      <div className="kos-ask-head">
        <span className="kos-ask-who">{asker ? `${asker} asks` : "KOS asks"}</span>
        {expiresAt !== undefined && <Countdown until={expiresAt} />}
      </div>
      {/* With steps, they are what is approved: the title says only what they act on, quieter. */}
      <p className={`kos-ask-title${view.steps ? " kos-ask-title--quiet" : ""}`}>{view.title}</p>
      {view.place && (
        <p className="kos-ask-place">
          <PlaceMark tool={tool} />
          <span>{view.place}</span>
        </p>
      )}
      {view.said && (
        <p className="kos-ask-said">
          <span>KOS says:</span> “{view.said}”
        </p>
      )}
      {view.secret && <AskSecretBlock secret={view.secret} />}
      {why && <p className="kos-ask-why">{why}</p>}
      {view.steps && <AskStepList steps={view.steps} />}
      {view.risk && (
        <span className="kos-ask-risk">
          <Tag tone="warn">{view.risk}</Tag>
        </span>
      )}
      {children}
      {args !== undefined && args !== "" && <AskDetails tool={tool} args={args} />}
      {meta && <p className="kos-ask-meta">{meta}</p>}
      {tooLong && <p className="kos-ask-meta">Too long to show here in full. Open it in the dashboard's Inbox to approve it.</p>}
      <div className="kos-ask-actions">
        {!tooLong && (
          <button type="button" className={`btn btn--primary${size}`} disabled={busy} title="Approve (Enter)" onClick={() => decide("yes")}>
            {working("yes", labels?.yes ?? "Approve")}
          </button>
        )}
        {always && (
          <button type="button" className={`btn${size}`} disabled={busy} onClick={() => decide("always")}>
            {busy && pressed === "always" ? (
              working("always", always)
            ) : (
              <Tooltip tip={<span className="kos-ask-tip">{view.alwaysTip ?? "Approves this, and stops asking for the same again. Undo it in Settings, Permissions."}</span>}>
                <span>{always}</span>
              </Tooltip>
            )}
          </button>
        )}
        <button type="button" className={`btn${size}`} disabled={busy} title="Deny (Esc)" onClick={() => decide("no")}>
          {working("no", labels?.no ?? "Deny")}
        </button>
        {extra}
        {/* Why there is no remembered yes, beside the buttons where it would have been. */}
        {!always && !noRemember && view.alwaysNote && <span className="kos-ask-note">{view.alwaysNote}</span>}
      </div>
    </section>
  );
}

/** A host split for reading: what comes before its registrable domain, and that domain, which is what says whose site it is. */
function hostParts(origin: string): { scheme: string; sub: string; domain: string; port: string } | undefined {
  const m = /^(https?:\/\/)([^/:]+)(:\d+)?$/.exec(origin);
  if (!m) return undefined;
  const host = m[2]!;
  const domain = registrableDomain(host);
  return { scheme: m[1]!, sub: host.slice(0, host.length - domain.length), domain, port: m[3] ?? "" };
}

/**
 * The secret a secrets tool's ask places, and where: its label and handle,
 * the fields, and the page's real origin large, its registrable domain in
 * bold, with the frames the fields sit in and what to weigh (a page that
 * is not encrypted, a site it was never filled on, a name in look-alike
 * letters). Never a value.
 */
export function AskSecretBlock({ secret }: { secret: AskSecret }): ReactElement {
  const parts = secret.origin ? hostParts(secret.origin) : undefined;
  const warnings = [...secret.warnings, ...(secret.origin?.includes("xn--") ? ["The address is spelled in look-alike letters (punycode)."] : [])];
  const frames = secret.frameOrigins.map((o) => o.replace(/^https?:\/\//, ""));
  return (
    <div className="kos-ask-secret">
      <p className="kos-ask-secret-what">
        <HiddenIcon size={14} title="" />
        <span>
          <strong>{secret.label}</strong> <code>{secret.handle}</code>
          {secret.fields.length > 0 && <span className="kos-ask-secret-fields"> · {secret.fields.map(secretFieldWords).join(", ")}</span>}
        </span>
      </p>
      {secret.origin && (
        <p className="kos-ask-secret-origin" title={secret.origin}>
          {parts ? (
            <>
              <span className="kos-ask-secret-faint">{parts.scheme}</span>
              {parts.sub}
              <strong>{parts.domain}</strong>
              {parts.port}
            </>
          ) : (
            secret.origin
          )}
        </p>
      )}
      {frames.length > 0 && <p className="kos-ask-secret-frames">In a frame from {frames.join(", ")}</p>}
      {secret.targets && secret.targets.length > 0 && (
        <p className="kos-ask-secret-frames">
          Into{" "}
          {secret.targets.map((t, i) => (
            <span key={i}>
              {i > 0 && ", "}
              {secretFieldWords(t.field)} → “{t.label || "unlabelled"}” ({t.type})
            </span>
          ))}
          {secret.formAction && <>, a form sending to {secret.formAction}</>}
        </p>
      )}
      {warnings.length > 0 && (
        <span className="kos-ask-risk">
          {warnings.map((w) => (
            <Tag key={w} tone="warn">
              {w}
            </Tag>
          ))}
        </span>
      )}
    </div>
  );
}

/** The focus came by the keyboard, not a click or a script. */
function keyboardFocused(el: HTMLElement): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return false;
  }
}

/** Each action of an ask, a line each, numbered when there are several. */
export function AskStepList({ steps }: { steps: StepLine[] }): ReactElement {
  if (steps.length === 1) {
    return (
      <p className="kos-ask-steps kos-ask-steps--one">
        <StepWords line={steps[0]!} />
      </p>
    );
  }
  return (
    <ol className="kos-ask-steps">
      {steps.map((line, i) => (
        <li key={i}>
          <StepWords line={line} />
        </li>
      ))}
    </ol>
  );
}

/** A step's line, its keys as keycaps. */
function StepWords({ line }: { line: StepLine }): ReactElement {
  return <>{line.map((piece, i) => ("key" in piece ? <kbd key={i} className="keycap">{piece.key}</kbd> : <span key={i}>{piece.text}</span>))}</>;
}

/** The site's own icon, or the kind of place's mark when there is no site or it has none. */
/**
 * The kind of place's own mark. Never a site's icon: fetching one would
 * reach whatever site the agent named, from the owner's browser, before
 * they said yes.
 */
function PlaceMark({ tool }: { tool: string }): ReactElement {
  if (tool.startsWith("computer.")) return <WindowIcon size={14} title="" />;
  if (tool.startsWith("files.") || tool === "shell.run" || tool === "python.run") return <PageIcon size={14} title="" />;
  if (/^mcp\.[^.]+\.(send_email|email_send)$/.test(tool)) return <MailIcon size={14} title="" />;
  if (tool.startsWith("mcp.")) return <ServerIcon size={14} title="" />;
  return <GlobeIcon size={14} title="" />;
}

/** Strings longer than this are cut, with Show all. */
const LONG = 240;

/** The arguments as JSON to copy, or the text as it came when it is not JSON (cut to fit by the host). */
function parsed(args: string | Record<string, unknown>): { value: unknown; json: string } {
  if (typeof args !== "string") return { value: args, json: JSON.stringify(args, null, 2) };
  try {
    const value = JSON.parse(args) as unknown;
    return { value, json: JSON.stringify(value, null, 2) };
  } catch {
    return { value: args, json: args };
  }
}

/**
 * The arguments, folded until asked for: the tool's name, each field by its
 * name, a list numbered, a long string cut with Show all, inside a box that
 * scrolls rather than running off the card; and Copy JSON.
 */
export function AskDetails({ tool, args }: { tool: string; args: string | Record<string, unknown> }): ReactElement {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const scroll = useOverlayScroll<HTMLDivElement>();
  const { value, json } = parsed(args);
  useEffect(() => {
    if (!copied) return undefined;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = (): void => {
    void navigator.clipboard?.writeText(json).then(() => setCopied(true), () => undefined);
  };
  return (
    <div className="ask-details">
      <button type="button" className="ask-details-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown size={12} title="" /> : <ChevronRight size={12} title="" />}
        Details
      </button>
      <Collapse open={open}>
        <div className="ask-details-body">
          <div className="ask-details-head">
            <Tag mono>{tool}</Tag>
            <button type="button" className="btn btn--sm btn--ghost ask-details-copy" onClick={copy}>
              {copied ? <CheckIcon size={12} title="" /> : <CopyIcon size={12} title="" />}
              {copied ? "Copied" : "Copy JSON"}
            </button>
          </div>
          <div className="ask-details-scroll" ref={scroll}>
            <Value value={value} />
          </div>
        </div>
      </Collapse>
    </div>
  );
}

/** One value of the arguments, as its kind reads. */
function Value({ value }: { value: unknown }): ReactElement {
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="ask-value ask-value--quiet">none</span>;
    return (
      <ol className="ask-value-list">
        {value.map((item, i) => (
          <li key={i}>
            <Value value={item} />
          </li>
        ))}
      </ol>
    );
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <span className="ask-value ask-value--quiet">empty</span>;
    return (
      <dl className="ask-fields">
        {entries.map(([key, v]) => (
          <div className="ask-field" key={key}>
            <dt>{key}</dt>
            <dd>
              <Value value={v} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  if (typeof value === "string") return <LongText text={value} />;
  return <span className="ask-value ask-value--mono">{value === null || value === undefined ? "null" : String(value)}</span>;
}

/** A string in full when short, cut with Show all when long. */
function LongText({ text }: { text: string }): ReactElement {
  const [all, setAll] = useState(false);
  const long = text.length > LONG;
  return (
    <span className="ask-value">
      {long && !all ? `${text.slice(0, LONG)}…` : text}
      {long && (
        <button type="button" className="ask-value-more" onClick={() => setAll((v) => !v)}>
          {all ? "Show less" : "Show all"}
        </button>
      )}
    </span>
  );
}

/** A turning ring, drawn so it spins smoothly. */
function Spinner(): ReactElement {
  return (
    <svg className="spinner" width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
