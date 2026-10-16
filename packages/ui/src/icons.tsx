import type { ReactElement } from "react";

/**
 * The small set of glyphs the chat surface uses.
 *
 * Drawn rather than written out: a row of the words copy, edit, retry and fork
 * under every message competes with the message. They share one stroke weight
 * and one box so they read as a set.
 */

function Icon({
  children,
  title,
  size = 15,
}: {
  children: React.ReactNode;
  title: string;
  size?: number;
}): ReactElement {
  return (
    <svg
      width={size}
      height={size}
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

/**
 * Chevrons for disclosure and collapse. Drawn as a stroke, not the guillemet
 * and triangle glyphs that used to stand in for them, so they match the icon
 * set and scale cleanly. Rotate with CSS where a control toggles open.
 */
export const ChevronRight = ({ size = 14 }: { size?: number } = {}): ReactElement => (
  <Icon title="Expand" size={size}>
    <path d="m9 6 6 6-6 6" />
  </Icon>
);

export const ChevronDown = ({ size = 14 }: { size?: number } = {}): ReactElement => (
  <Icon title="Collapse" size={size}>
    <path d="m6 9 6 6 6-6" />
  </Icon>
);

export const ChevronLeft = ({ size = 14 }: { size?: number } = {}): ReactElement => (
  <Icon title="Collapse" size={size}>
    <path d="m15 6-6 6 6 6" />
  </Icon>
);

/**
 * A window with a column on one side: a side panel, the chat list or the
 * workspace. Open, the column is filled in; shut, it is an outline.
 */
export const PanelIcon = ({
  size = 16,
  side = "right",
  on = false,
}: { size?: number; side?: "left" | "right"; on?: boolean } = {}): ReactElement => (
  <Icon title="Side panel" size={size}>
    {on && (
      <rect
        x={side === "right" ? 15 : 3}
        y="4"
        width="6"
        height="16"
        rx="2"
        fill="currentColor"
        stroke="none"
        opacity="0.45"
      />
    )}
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d={side === "right" ? "M15 4v16" : "M9 4v16"} />
  </Icon>
);

/** Head actions: a gear, a box with a lid, an arrow out, and a pin in or out. */
export const GearIcon = (): ReactElement => (
  <Icon title="Configure">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </Icon>
);

export const ArchiveIcon = (): ReactElement => (
  <Icon title="Archive">
    <rect x="3" y="4" width="18" height="5" rx="1" />
    <path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4" />
  </Icon>
);

export const OpenIcon = (): ReactElement => (
  <Icon title="Open">
    <path d="M7 17 17 7M9 7h8v8" />
  </Icon>
);

export const PinIcon = (): ReactElement => (
  <Icon title="Attached">
    <path d="M9 4h6l-1 6 3 3v1H7v-1l3-3-1-6zM12 14v6" />
  </Icon>
);

export const UnpinIcon = (): ReactElement => (
  <Icon title="Detached">
    <path d="M9 4h6l-1 6 3 3v1H7v-1l3-3-1-6zM12 14v6M4 4l16 16" />
  </Icon>
);

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
    case "settings": return p("c12,12,3|M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z");
    case "search": return p("c11,11,7|M21 21l-4.3-4.3");
    // A speech bubble with a question mark: a quick question on the side.
    case "browser": return p("c12,12,9|M3 12h18|M12 3a14 14 0 0 1 0 18|M12 3a14 14 0 0 0 0 18");
    case "ask": return p("M21 11.5a8.4 8.4 0 0 1-8.5 8.5 8.6 8.6 0 0 1-3.8-.9L3 21l1.9-5.7A8.4 8.4 0 0 1 4 11.5 8.4 8.4 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5z|M10.2 9.4a2.3 2.3 0 1 1 3.2 2.1c-.6.3-.9.8-.9 1.4|M12.5 16h.01");
    case "more": return p("c5,12,1|c12,12,1|c19,12,1");
    default: return p("c12,12,9");
  }
}
