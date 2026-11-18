/**
 * KOS's cursor as KOS for Mac draws and moves it, in numbers: the arrow and
 * its halo, glow and tag (KOSCursor.swift), the ripple, the colours
 * (Palette.swift) and the glide (DeviceCore's Glide.swift). The overlay is
 * handed these when it is put in a page; extension.test.ts reads the Swift
 * and holds both to the same numbers.
 */
export const CURSOR = {
  /** The arrow's outline, tip at 0,0, y down, at the system cursor's size. */
  outline: [
    [0, 0],
    [0, 17],
    [4.2, 13.3],
    [7, 19.5],
    [9.6, 18.4],
    [6.9, 12.3],
    [12.5, 12.3],
  ],
  /** Drawn half as big again as the system's arrow. */
  scale: 1.5,
  /** The dark palette's accent and the ink on it, in either theme: they glow over any page. */
  blue: "#7c9cff",
  ink: "#0b0e14",
  stroke: 1.4,
  /** The glow behind the arrow: its radius and its opacity. */
  glow: { radius: 7, opacity: 0.95 },
  halo: { radius: 15, fill: 0.16, edge: 0.55, line: 1.2 },
  tag: { left: 14, top: 28, height: 16, padding: 6, radius: 6, font: 10, weight: 600, shadow: 0.25 },
  ripple: { radius: 18, fill: 0.18, line: 2, from: 0.35, to: 1.5, ms: 450 },
  /** Seconds, and points: a glide's steps a second, its shortest and longest, the distance it is longest at, a quick one's share, and its arc. */
  glide: { rate: 120, shortest: 0.15, longest: 0.45, far: 1500, quickShare: 0.3, bendMost: 40, bendShare: 0.06 },
} as const;

export type CursorLook = typeof CURSOR;
