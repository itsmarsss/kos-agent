import { EASE, SPRING } from "@kos/shared";
import type { Transition, Variants } from "motion/react";

/**
 * Shared motion vocabulary.
 *
 * One spring and one duration for the dashboard and KOS for Chrome alike, so
 * movement reads as the same system rather than each component inventing its
 * own timing. Distances stay small: motion is here to make a change legible,
 * not to be noticed.
 *
 * Reduced motion is handled where each app mounts, by MotionConfig, which
 * drops transforms and keeps opacity, so nothing here needs to branch on it.
 */

/** Panels and anything that travels: settles without overshoot wobble. */
export const spring: Transition = { type: "spring", ...SPRING };

/** Fades and small reveals. */
export const ease: Transition = { duration: EASE.duration, ease: [...EASE.curve] };

/** What answers the pointer: a hover, a switch's knob. KOS for Mac's `Theme.hover`, and the stylesheets' 140 ms. */
export const hover: Transition = { duration: 0.14, ease: "easeOut" };

/**
 * What a drawer opens to, appearing once the room for it is made and gone
 * before the room closes, never sliding: KOS for Mac's `HomeView.inPlace`.
 */
export const inPlace = {
  enter: { duration: 0.2, ease: "easeOut", delay: 0.1 },
  exit: { duration: 0.1, ease: "easeIn" },
} as const satisfies Record<string, Transition>;

/**
 * A page that comes in from its own side and leaves to it, while the other
 * moves at once, on the spring: KOS for Mac's page move. `custom` is the
 * side, -1 for the leading edge, 1 for the trailing.
 */
export const pageMove: Variants = {
  out: (side: number) => ({ x: `${side * 100}%`, opacity: 0 }),
  in: { x: 0, opacity: 1 },
};

/** A card arriving in a list or leaving it, from its top, while the list makes room around it: KOS for Mac's. */
export const arrive: Variants = {
  hidden: { opacity: 0, scale: 0.98, originY: 0 },
  show: { opacity: 1, scale: 1, originY: 0 },
};

/** What drops in over the page's top and leaves back up: a live session, as KOS for Mac moves it. */
export const fromTop: Variants = {
  hidden: { opacity: 0, y: "-100%" },
  show: { opacity: 1, y: 0 },
};

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
