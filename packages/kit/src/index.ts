/**
 * @kos/kit
 *
 * The React pieces the dashboard and KOS for Chrome are both drawn with:
 * KOS's face, the markdown KOS speaks in, one set of icons, the small
 * controls, and the motion they move with. kit.css draws them on the shared
 * tokens; each app loads it beside its own stylesheet.
 */

export { arrive, card, ease, fromTop, hover, inPlace, listItem, pageMove, spring, stagger } from "./motion.js";
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
export { KindMark, Markdown, MentionNames, RefChip, RefLinks } from "./Markdown.js";
export { BlockActions, KosBlockView, type BlockText } from "./KosBlock.js";
export { Field, Req, type FieldProps } from "./Field.js";
export { Tex } from "./Tex.js";
export { MessageTime, TAPPED_MS, TimeCard, TimeLine, Timed, useTimeReveal, useToday, type TimeRevealProps } from "./ChatTime.js";
export { Tooltip, type TooltipAnchorProps, type TooltipProps } from "./Tooltip.js";
export { Countdown, QuoteLine, quoteSource, Card, Chips, Collapse, Count, Empty, type CardProps, type ChipOption, DrawerRow, Elapsed, formatElapsed, IconButton, IconLink, Pill, PictureViewer, Section, Skeleton, StatusDot, StepPicture, StepTime, Switch, Tag, WorkingDots, type DotState, type IconButtonProps, type Tone } from "./kit.js";
export { AskCard, AskDetails, AskStepList, type AskCardProps } from "./AskCard.js";
export { useDismiss, type DismissOptions } from "./useDismiss.js";
export { isModeKey, ModeChip } from "./ModeChip.js";
export { useFocusTrap } from "./useFocusTrap.js";
export { overlayScroll, useOverlayScroll } from "./OverlayScroll.js";
export * from "./icons.js";
