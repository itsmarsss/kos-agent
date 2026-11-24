/**
 * @kos/kit
 *
 * The React pieces the dashboard and KOS for Chrome are both drawn with:
 * KOS's face, the markdown KOS speaks in, one set of icons, the small
 * controls, and the motion they move with. kit.css draws them on the shared
 * tokens; each app loads it beside its own stylesheet.
 */

export { arrive, card, ease, float, fromTop, hover, inPlace, listItem, pageArrive, pageMove, rise, spring, stagger } from "./motion.js";
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
export { checkOrigin, hintWords, masksText, OriginList, PAYMENT_FRAMES, SecretField, clearSecretValues, readSecretValues, takeSecretValues, type OriginListProps, type OriginMode, type SecretFieldProps } from "./Secrets.js";
export { Tex } from "./Tex.js";
export { MessageTime, TAPPED_MS, TimeCard, TimeLine, Timed, useTimeReveal, useToday, type TimeRevealProps } from "./ChatTime.js";
export { Tooltip, type TooltipAnchorProps, type TooltipProps } from "./Tooltip.js";
export { Countdown, QuoteLine, quoteSource, Card, Chips, Collapse, Count, type CardProps, type ChipOption, DrawerRow, Elapsed, formatElapsed, IconButton, IconLink, Marked, Pill, PictureViewer, Section, StatusPill, Skeleton, StatusDot, StepPicture, StepTime, Switch, Tag, WorkingDots, type DotState, type IconButtonProps, type Tone } from "./kit.js";
export { EmptyState, listState, noMatchWords, type EmptyStateProps, type ListState } from "./EmptyState.js";
export { When } from "./When.js";
export { SheetFoot, SheetHead, type SheetFootProps } from "./Sheet.js";
export { GroupHead, ListHead, NotFound, PaneHead, SearchField, TableGroup, TableHead, type Column } from "./PageParts.js";
export { PlacePicker, type Place } from "./PlacePicker.js";
export { ASK_SETTLE_MS, AskCard, AskDetails, AskSecretBlock, AskStepList, type AskCardProps } from "./AskCard.js";
export { useDismiss, type DismissOptions } from "./useDismiss.js";
export { Menu, menuPlace, type MenuItem, type MenuProps, type MenuSide } from "./Menu.js";
export { ModeChip } from "./ModeChip.js";
export { announce, ANNOUNCE_GAP_MS, Announcer, type Politeness } from "./Announcer.js";
export { restoreFocus, tabStops, useFocusTrap, type FocusTrapOptions } from "./useFocusTrap.js";
export { openLayer, sheetOpen, type Layer } from "./layers.js";
export { useSteadyPress } from "./useSteadyPress.js";
export { overlayScroll, useOverlayScroll } from "./OverlayScroll.js";
export { Fold, foldOf, MIN_HIDDEN_LINES, type FoldRule } from "./Fold.js";
export * from "./icons.js";
