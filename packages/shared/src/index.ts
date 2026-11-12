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
  WidgetOutline,
  WidgetSpan,
  WidgetType,
} from "./pagespec.js";
export { DEFAULT_HOME, SPAN_COLUMNS, outlineOf, parseHomeLayout, widgetSpan } from "./pagespec.js";
export {
  isReadOnlyQuery,
  isValidPageSpec,
  validatePageSpec,
} from "./pagespec-validate.js";
export {
  DESCRIPTION_MAX,
  RENAME_DESCRIPTION_MAX,
  RENAME_TITLE_MAX,
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
  stepActions,
  stepMechanics,
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
export {
  UNCHANGED,
  WAIT_BUDGET_MS,
  RunError,
  ScreenMemory,
  WaitBudget,
  abortable,
  actionsOf,
  digestOf,
  doneText,
  hasActions,
  pause,
  runActions,
  stoppedAt,
  stoppedDuring,
  type ActThen,
  type ActionContext,
  type RunAdapter,
  type RunOptions,
} from "./screenrun.js";
export { TIME_TOKEN, formatTime, instantOf, relativeWords, styleOf, timeCard, timesInWords, withUnixTimes, type TimeStyle } from "./time.js";
export { pathsIn, type PathPart } from "./workspacepath.js";
export { CHANNEL_TOKEN, channelNamesIn } from "./channel.js";
export { MENTION_KINDS, MENTION_SOURCE, type MentionKind } from "./mentions.js";
export { MATH, displayMathAt, mathOf, type MathSource } from "./math.js";
export { desaturateHex, hexOfHsv, hsvOfHex, type Hsv } from "./colour.js";
export { COLOURS, EASE, FLOAT_SHADOW, isDrawnTheme, isThemeMode, LIGHT_COLOURS, RADII, readDashboardTheme, resolveThemeMode, SPRING, TYPE, type ColourToken, type DashboardTheme, type DrawnTheme, type ThemeMode } from "./design.js";
export { colourOf, sameGround, type Rgba } from "./colourof.js";
export { listAt, startsList, type MdList, type MdListItem } from "./lists.js";
export {
  BRIDGE_SCRIPT,
  FIT_KINDS,
  FRAME_HEIGHT_MAX,
  FRAME_QUERY_WAIT_MS,
  GUARD_SCRIPT,
  RTC_GUARD,
  PAGE_CSP,
  PAGE_GUARD_CSP,
  WRAPPER_CSP,
  fitsContent,
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
  DOC_EDIT_MAX,
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
export { EXPORT_FORMATS, EXPORT_WORDS, KIND_EXPORTS, exportName, isExportFormat, type ExportFormat } from "./artifactexport.js";
export { ARTIFACT_FONTS, fontById, fontFaceCss, fontStackVars, type ArtifactFont, type FontFile, type FontRole } from "./artifactfonts.js";
