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
