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
  DESCRIPTION_MAX,
  FONTS_MAX,
  HTML_PAGE_MAX,
  PAGE_LIBRARIES,
  sheetDataOf,
  withSheetData,
  exitsIn,
  validateHtmlPage,
  type HtmlPage,
  type PageCapabilities,
  type PageHeadline,
  type PageLibrary,
} from "./htmlpage.js";

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
  drawingOf,
  hashName,
  hexOfHsl,
  hueOfHex,
  hueOfName,
  inkOf,
  inkOn,
  lightnessOf,
  lightnessOfHex,
  lookOf,
  readDrawing,
  SHAPE_WORD_MAX,
  shapeOf,
  shapeWordOf,
  type FaceColour,
  type FaceDrawing,
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
  isConvex,
  outline,
  smoothPath,
  smoothPolygon,
  smoothSegments,
  type BlobEyes,
  type BlobGait,
  type BlobShape,
  type BlobWhim,
  type Lobe,
} from "./blob.js";
export type { ActionNames } from "./format-action.js";
export { TIME_TOKEN, formatTime, instantOf, relativeWords, styleOf, timeCard, timesInWords, withUnixTimes, type TimeStyle } from "./time.js";
export { pathsIn, type PathPart } from "./workspacepath.js";
export { CHANNEL_TOKEN, channelNamesIn } from "./channel.js";
export { MENTION_KINDS, MENTION_SOURCE, type MentionKind } from "./mentions.js";
export { MATH, displayMathAt, mathOf, type MathSource } from "./math.js";
export { desaturateHex, hexOfHsv, hsvOfHex, type Hsv } from "./colour.js";
export { COLOURS, EASE, FLOAT_SHADOW, RADII, SPRING, TYPE, type ColourToken } from "./design.js";
export { listAt, startsList, type MdList, type MdListItem } from "./lists.js";
export {
  BRIDGE_SCRIPT,
  GUARD_SCRIPT,
  PAGE_CSP,
  PAGE_GUARD_CSP,
  WRAPPER_CSP,
  pageDocument,
  splitHtml,
  tokenRule,
  wrapperDocument,
  type PageDocumentInput,
} from "./artifactdoc.js";
export {
  ARTIFACT_KINDS,
  DECK_REGION,
  DOC_REGION,
  KIND_FONTS,
  KIND_RUNTIME,
  SHEET_DATA,
  SHEET_ROWS_MAX,
  WORKSPACE_SCOPE,
  artifactAssets,
  isArtifactKind,
  sheetErrors,
  sheetTables,
  type ArtifactEdit,
  type ArtifactKind,
  type SheetAggregate,
  type SheetBook,
  type SheetCell,
  type SheetChart,
  type SheetColumn,
  type SheetColumnType,
  type SheetTab,
} from "./artifacts.js";
export { ARTIFACT_FONTS, fontById, fontFaceCss, fontStackVars, type ArtifactFont, type FontFile, type FontRole } from "./artifactfonts.js";
