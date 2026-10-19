/**
 * @kos/shared
 *
 * Types and contracts shared across the harness and UI: the skill contract,
 * the page-spec schema, and other cross-package primitives. Both sides import
 * from here so the contract has a single source of truth.
 */

export const KOS_VERSION = "0.0.0";

export {
  capabilityKey,
  type CapabilityKind,
  type CapabilityRef,
  type ModuleManifest,
  type NeededCapability,
  type ProvidedCapability,
} from "./module.js";

export type {
  BaseWidget,
  CardWidget,
  ChartKind,
  ChartWidget,
  CustomHtmlWidget,
  FormWidget,
  ListWidget,
  MarkdownWidget,
  MutationTarget,
  PageSpec,
  StatWidget,
  TableWidget,
  HomeLayout,
  HomePanel,
  PanelKind,
  Widget,
  WidgetSpan,
  WidgetType,
} from "./pagespec.js";
export { DEFAULT_HOME, parseHomeLayout } from "./pagespec.js";
export {
  isReadOnlyQuery,
  isValidPageSpec,
  validatePageSpec,
} from "./pagespec-validate.js";

export {
  detailLines,
  formatApprovalPrompt,
  summarizeAction,
} from "./format-action.js";

export {
  CHAT_COMMANDS,
  COMMAND_NAMES,
  type CommandSpec,
} from "./commands.js";

export {
  EYES,
  EYE_DOT_R,
  EYE_GLINT,
  EYE_PILL,
  FILL_SAT,
  faceSvg,
  KOS_HUE,
  KOS_SEED,
  bodyHexOf,
  hashName,
  hexOfHsl,
  hueOfHex,
  hueOfName,
  inkOf,
  inkOn,
  lightnessOf,
  lightnessOfHex,
  lookOf,
  type FaceColour,
  type FaceLook,
  type FaceSpec,
} from "./face.js";

export {
  CENTER,
  EYE_L,
  EYE_R,
  PLAIN_SHAPE,
  PLAIN_WHIM,
  POINTS,
  RADIUS,
  eyeAt,
  outline,
  smoothPath,
  smoothPolygon,
  smoothSegments,
  type BlobEyes,
  type BlobGait,
  type BlobShape,
  type BlobWhim,
} from "./blob.js";
export { TIME_TOKEN, formatTime, instantOf, relativeWords, styleOf, timesInWords, withUnixTimes, type TimeStyle } from "./time.js";
export { pathsIn, type PathPart } from "./workspacepath.js";
export { CHANNEL_TOKEN, channelNamesIn } from "./channel.js";
