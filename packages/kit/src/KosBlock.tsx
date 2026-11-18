import { createContext, useContext, useEffect, useState, type ReactElement, type ReactNode } from "react";

import {
  checklistOf,
  copyOf,
  diffLineOf,
  icsOf,
  mailtoOf,
  mapOf,
  sendRequestOf,
  sendToolOf,
  stepsOf,
  viewOf,
  type BlockView,
  type KosBlock,
} from "@kos/shared";

import { CalendarIcon, CheckIcon, CopyIcon, ExternalIcon, MailIcon, PlaceIcon, SendIcon } from "./icons.js";
import { IconButton, IconLink } from "./kit.js";

/**
 * A typed block (docs/blocks.md), drawn as the thing it is: its kind's head
 * with its actions, its fields in two aligned columns, then its body.
 *
 * Every action is local (Copy, a mailto: link, an .ics, a map) or a request
 * to KOS in the owner's words (Send), whose tool call is tiered and approved
 * as any other. The surface says which tools there are and where words go
 * (BlockActions); without it, Send is not offered.
 */

/** What the surface lends a block: the tools this KOS has, and a way to say something to KOS in this chat. */
export interface BlockActions {
  tools: readonly string[];
  ask(text: string): void;
}

export const BlockActions = createContext<BlockActions | null>(null);

/** How the markdown around a block draws its words, lent so a field reads as the prose does. */
export interface BlockText {
  inline(text: string): ReactNode;
  markdown(text: string): ReactNode;
}

/** A press that says it worked for a moment: Copy's tick, Send's. */
function useDone(): [boolean, () => void] {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return undefined;
    const timer = setTimeout(() => setDone(false), 1600);
    return () => clearTimeout(timer);
  }, [done]);
  return [done, () => setDone(true)];
}

function CopyButton({ text }: { text: string }): ReactElement {
  const [done, mark] = useDone();
  const copy = (): void => {
    void navigator.clipboard?.writeText(text).then(mark, () => undefined);
  };
  return (
    <IconButton label={done ? "Copied" : "Copy"} onClick={copy}>
      {done ? <CheckIcon size={14} title="" /> : <CopyIcon size={14} title="" />}
    </IconButton>
  );
}

/** Send: the owner's words asking KOS to send the draft with the tool it has; asked once. */
function SendButton({ block, tool, ask }: { block: KosBlock; tool: string; ask: (text: string) => void }): ReactElement {
  const [asked, setAsked] = useState(false);
  return (
    <IconButton
      label={asked ? "Asked KOS to send it" : "Send"}
      title={asked ? "Asked KOS to send it" : `Ask KOS to send it with ${tool}; it asks you first`}
      disabled={asked}
      onClick={() => {
        setAsked(true);
        ask(sendRequestOf(block, tool));
      }}
    >
      {asked ? <CheckIcon size={14} title="" /> : <SendIcon size={14} />}
    </IconButton>
  );
}

/** An .ics of the event, saved by the browser. */
function CalendarButton({ ics, name }: { ics: string; name: string }): ReactElement {
  const save = (): void => {
    const url = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "event"}.ics`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  return (
    <IconButton label="Add to calendar" onClick={save}>
      <CalendarIcon size={14} />
    </IconButton>
  );
}

/**
 * The block's actions. Until its fence closes (a reply still arriving, or
 * one cut short) the draft is not the draft yet, so only Copy is offered.
 */
function Actions({ block, view, closed }: { block: KosBlock; view: BlockView; closed: boolean }): ReactElement {
  const surface = useContext(BlockActions);
  const actions = closed ? view.kind.actions : [];
  const tool = actions.includes("send") && surface ? sendToolOf(block, surface.tools) : undefined;
  const ics = actions.includes("ics") ? icsOf(block) : undefined;
  const map = actions.includes("map") ? mapOf(block) : undefined;
  return (
    <span className="card-acts kblock-acts">
      {(closed ? view.links : []).map((link) => (
        <IconLink key={link.href} label={`${link.label} (${link.host})`} href={link.href} target="_blank" rel="noopener noreferrer">
          <ExternalIcon size={14} />
        </IconLink>
      ))}
      {map && (
        <IconLink label="Open in Maps" href={map} target="_blank" rel="noopener noreferrer">
          <PlaceIcon size={14} />
        </IconLink>
      )}
      {ics && <CalendarButton ics={ics} name={view.title ?? "event"} />}
      {actions.includes("mail") && (
        <IconLink label="Open in Mail" href={mailtoOf(block)}>
          <MailIcon size={14} />
        </IconLink>
      )}
      {tool && surface && <SendButton block={block} tool={tool} ask={surface.ask} />}
      <CopyButton text={copyOf(block)} />
    </span>
  );
}

/** A checklist whose boxes tick here only: the reply is not changed by it. */
function Checklist({ body, text }: { body: string; text: BlockText }): ReactElement {
  return (
    <ul className="kblock-checks">
      {checklistOf(body).map((item, n) =>
        item.done === undefined ? (
          <li key={n} className="kblock-check-note">
            {text.inline(item.text)}
          </li>
        ) : (
          <li key={n}>
            <label className="kblock-check">
              <input type="checkbox" defaultChecked={item.done} />
              <span>{text.inline(item.text)}</span>
            </label>
          </li>
        ),
      )}
    </ul>
  );
}

function Body({ view, text }: { view: BlockView; text: BlockText }): ReactElement {
  const { body } = view;
  switch (view.kind.body) {
    case "markdown":
      return <div className="kblock-body kblock-md">{text.markdown(body)}</div>;
    case "mono":
      return (
        <pre className="kblock-code">
          <code>{body}</code>
        </pre>
      );
    case "diff":
      return (
        <pre className="kblock-code kblock-diff">
          <code>
            {body.split("\n").map((line, n) => (
              <span key={n} className={`kblock-diff-${diffLineOf(line)}`}>
                {line}
                {"\n"}
              </span>
            ))}
          </code>
        </pre>
      );
    case "checklist":
      return <Checklist body={body} text={text} />;
    case "steps":
      return (
        <ol className="kblock-steps">
          {stepsOf(body).map((step, n) => (
            <li key={n}>{text.inline(step)}</li>
          ))}
        </ol>
      );
    case "quote":
      return <blockquote className="kblock-body kblock-quote">{body}</blockquote>;
    case "text":
      return <div className="kblock-body kblock-text">{body}</div>;
  }
}

/** `closed` false: the fence has not closed yet, so the block offers Copy alone. */
export function KosBlockView({ block, closed = true, text }: { block: KosBlock; closed?: boolean; text: BlockText }): ReactElement {
  const view = viewOf(block);
  const { kind, title, rows, body } = view;
  // A card has no kind to name: its title heads it.
  const head = kind.label ? <span className="label">{kind.label}</span> : <strong className="kblock-title">{title ? text.inline(title) : "Note"}</strong>;
  return (
    <section className={`card kblock kblock--${kind.body}`} aria-label={kind.label || title || "Note"} data-kind={block.kind}>
      <div className="card-head kblock-head">
        {head}
        <Actions block={block} view={view} closed={closed} />
      </div>
      {kind.label && title && <strong className="kblock-title">{text.inline(title)}</strong>}
      {rows.length > 0 && (
        <dl className="kblock-rows">
          {rows.map((row) => (
            <div key={row.key} className="kblock-row">
              <dt>{row.label}</dt>
              <dd>
                {row.values.map((value, n) => (
                  <span key={n} className="kblock-value">
                    {text.inline(value)}
                  </span>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {body && <Body view={view} text={text} />}
    </section>
  );
}
