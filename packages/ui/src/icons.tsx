import type { ReactElement } from "react";

/**
 * The small set of glyphs the chat surface uses.
 *
 * Drawn rather than written out: a row of the words copy, edit, retry and fork
 * under every message competes with the message. They share one stroke weight
 * and one box so they read as a set.
 */

function Icon({ children, title }: { children: React.ReactNode; title: string }): ReactElement {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      role="img"
    >
      <title>{title}</title>
      {children}
    </svg>
  );
}

export const CopyIcon = (): ReactElement => (
  <Icon title="Copy">
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V6a2 2 0 0 1 2-2h9" />
  </Icon>
);

export const CheckIcon = (): ReactElement => (
  <Icon title="Copied">
    <path d="m5 13 4 4L19 7" />
  </Icon>
);

export const EditIcon = (): ReactElement => (
  <Icon title="Edit">
    <path d="M4 20h4L20 8a2.8 2.8 0 0 0-4-4L4 16v4Z" />
    <path d="m14 6 4 4" />
  </Icon>
);

export const RetryIcon = (): ReactElement => (
  <Icon title="Retry">
    <path d="M20 11a8 8 0 1 0-2.3 5.7" />
    <path d="M20 4v7h-7" />
  </Icon>
);

export const ForkIcon = (): ReactElement => (
  <Icon title="Fork">
    <circle cx="7" cy="19" r="2.2" />
    <circle cx="7" cy="5" r="2.2" />
    <circle cx="17" cy="9" r="2.2" />
    <path d="M7 7.2v9.6M7 12h5a3 3 0 0 0 3-3" />
  </Icon>
);

export const MoreIcon = (): ReactElement => (
  <Icon title="More">
    <circle cx="12" cy="5" r="1.2" fill="currentColor" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" />
    <circle cx="12" cy="19" r="1.2" fill="currentColor" />
  </Icon>
);

/** A line icon for each nav destination, so the sidebar reads as a rail when collapsed. */
export function NavIcon({ name }: { name: string }): ReactElement {
  const p = (d: string): ReactElement => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {d.split("|").map((seg, i) => (seg.startsWith("c") ? <circle key={i} cx={+seg.slice(1).split(",")[0]!} cy={+seg.slice(1).split(",")[1]!} r={+seg.slice(1).split(",")[2]!} /> : <path key={i} d={seg} />))}
    </svg>
  );
  switch (name) {
    case "chats": return p("M21 11.5a8.4 8.4 0 0 1-8.5 8.5 8.6 8.6 0 0 1-3.8-.9L3 21l1.9-5.7A8.4 8.4 0 0 1 4 11.5 8.4 8.4 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5z");
    case "inbox": return p("M22 12h-6l-2 3h-4l-2-3H2|M5.5 5h13l3.5 7v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-6z");
    case "home": return p("M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z");
    case "projects": return p("M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z");
    case "files": return p("M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6");
    case "memory": return p("M5 6c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3z|M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6|M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3");
    case "history": return p("M3 12a9 9 0 1 0 3-6.7L3 8|M3 4v4h4|M12 8v4l3 2");
    case "settings": return p("c12,12,3|M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1");
    default: return p("c12,12,9");
  }
}
