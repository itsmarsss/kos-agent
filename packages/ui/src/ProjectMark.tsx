import type { CSSProperties, ReactElement } from "react";

import { lightnessOfHex } from "./colour.js";
import { lookOf } from "./Face.js";

/** Ink for the mark on a picked colour: pale on a dark one, dark on a light one. */
export function markInk(colour: string): string {
  return (lightnessOfHex(colour) ?? 60) < 55 ? "rgb(255 255 255 / 0.9)" : "rgb(0 0 0 / 0.7)";
}

/**
 * A project's mark in its colour: the owner's, else a soft one its slug
 * gives. For the soft one only the hue is set; the stylesheet picks the tint
 * and the ink for the theme, since pale ink on a pale tint was all but
 * invisible in the light one.
 */
export function markStyle(slug: string, colour: string | null | undefined): CSSProperties {
  if (colour) return { background: colour, color: markInk(colour) };
  return { "--blob-h": lookOf(slug).hue } as CSSProperties;
}

/**
 * A project as a small tile with its first letter, for a row in a list:
 * the colour tells projects apart at a glance where a word in a pill
 * beside each name only made the list busier.
 */
export function ProjectMark({ slug, name, colour }: { slug: string; name: string; colour?: string | null }): ReactElement {
  const letter = [...name.trim()][0]?.toUpperCase() ?? "?";
  return (
    <span className="project-mark" aria-hidden="true" style={markStyle(slug, colour)}>
      {letter}
    </span>
  );
}
