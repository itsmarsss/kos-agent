import { EASE, SPRING } from "@kos/shared";
import type { Transition, Variants } from "motion/react";

/**
 * Shared motion vocabulary.
 *
 * One spring and one duration for the whole surface, so movement reads as the
 * same system rather than each component inventing its own timing. Distances
 * stay small: this is a dashboard, and motion is here to make a change legible,
 * not to be noticed.
 *
 * Reduced motion is handled globally by MotionConfig in main.tsx, which drops
 * transforms and keeps opacity, so nothing here needs to branch on it.
 */

/** Panels and anything that travels: settles without overshoot wobble. */
export const spring: Transition = { type: "spring", ...SPRING };

/** Fades and small reveals. */
export const ease: Transition = { duration: EASE.duration, ease: [...EASE.curve] };

/** A row entering or leaving a list. */
export const listItem: Variants = {
  hidden: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4, transition: { duration: 0.12 } },
};

/** Container that reveals its children in sequence on first mount. */
export const stagger: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.035, delayChildren: 0.02 } },
};

/** A card lifting into place. */
export const card: Variants = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: ease },
};
