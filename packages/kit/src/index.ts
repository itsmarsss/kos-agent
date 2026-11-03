/**
 * @kos/kit
 *
 * The React pieces the dashboard and KOS for Chrome are both drawn with:
 * KOS's face, the markdown KOS speaks in, one set of icons, the small
 * controls, and the motion they move with. kit.css draws them on the shared
 * tokens; each app loads it beside its own stylesheet.
 */

export { card, ease, listItem, spring, stagger } from "./motion.js";
export {
  AgentFaces,
  EYES,
  FILL_SAT,
  Face,
  KOS_SEED,
  KosLook,
  faceDataUrl,
  faceLookOf,
  faceSvg,
  fillOf,
  lightnessOf,
  lookOf,
  moodOf,
  useKosLook,
  wearing,
  type Eyes,
  type FaceLook,
  type FaceProps,
  type Gait,
  type Look,
  type Mood,
} from "./Face.js";
export { KindMark, Markdown, MentionNames, RefLinks } from "./Markdown.js";
export { Tex } from "./Tex.js";
export { Chips, Collapse, DrawerRow, IconButton, Pill, Section, Switch, Tag, WorkingDots, type IconButtonProps, type Tone } from "./kit.js";
export * from "./icons.js";
