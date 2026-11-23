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
  actionSteps,
  detailLines,
  formatApprovalPrompt,
  secretFieldWords,
  stepActions,
  stepMechanics,
  stepText,
  summarizeAction,
  type StepLine,
  type StepPiece,
} from "./format-action.js";

export { formatDuration, waitWords } from "./duration.js";

export { hasSecretRef, usesSecret } from "./secretref.js";
export { registrableDomain } from "./domain.js";
export {
  SECRET_FIELDS,
  SECRET_KINDS,
  SECRET_REQUIRED,
  SECRET_TOOLS,
  CODE_HANDLE,
  CODE_MAX,
  CODE_MIN,
  CODE_TTL_MS,
  codeProblem,
  ONE_TIME_CODE,
  typedCode,
  type AskSecret,
  type SecretBilling,
  type SecretFieldName,
  type SecretGrant,
  type SecretKind,
  type SecretPolicy,
  type SecretRemember,
  type SecretSummary,
  type SecretSurface,
  type SecretUse,
  type SecretUseRow,
  type SecretValues,
  type VaultSlotKind,
  type VaultStatus,
} from "./secrets.js";

export { BIDI, showInvisible } from "./invisible.js";

export { keyCap, keyCaps, keyPlatformOf, type KeyPlatform } from "./keys.js";

export {
  alwaysTip,
  alwaysWords,
  askPlace,
  askRisk,
  askView,
  type AskInput,
  type AskPlace,
  type AskRule,
  type AskView,
} from "./ask.js";

export {
  CHAT_COMMANDS,
  COMMAND_NAMES,
  type CommandOption,
  type CommandPick,
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
export type { ActionHome, ActionNames } from "./format-action.js";
export {
  LAYOUT_FOLDERS,
  ROOT_HOME,
  WORKSPACE_MARK,
  foldName,
  homeWords,
  outsideHome,
  placePath,
  placeWords,
  reachWords,
  inFolder,
  type FileHome,
  type PlacedPath,
} from "./filehome.js";
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
export { APPROVED_PREFIX, DENIED_PREFIX, LAPSED_PREFIX, NOT_RUN_PREFIX, OLD_DENIED_PREFIX, isUndone, outcomeOf, type CallOutcome } from "./calloutcome.js";
export { GAP_MS, clockWords, dayNumber, dayWords, markWords, momentWords, readerTime, timeMarks, type TimeMark } from "./chattime.js";
export { TIME_TOKEN, formatTime, instantOf, relativeWords, styleOf, timeCard, timesInWords, timeWords, withUnixTimes, type TimeStyle } from "./time.js";
export { isState, STATE_WORDS, stateOfRun, type State, type StateTone } from "./states.js";
export { KIND_WORDS, kindWord, providerWord, scheduleName, slugWords, SYSTEM_SCHEDULE_ABOUT, SYSTEM_SCHEDULES } from "./words.js";
export { pathsIn, type PathPart } from "./workspacepath.js";
export { CHANNEL_TOKEN, channelNamesIn, surfaceName } from "./channel.js";
export { MENTION_KINDS, MENTION_SOURCE, type MentionKind } from "./mentions.js";
export { MATH, displayMathAt, mathOf, type MathSource } from "./math.js";
export { desaturateHex, hexOfHsv, hsvOfHex, type Hsv } from "./colour.js";
export { COLOURS, EASE, FLOAT_SHADOW, HOVER, isDrawnTheme, isThemeMode, LIGHT_COLOURS, PRESS, RADII, readDashboardTheme, resolveThemeMode, SPRING, TOUCH, TYPE, type ColourToken, type DashboardTheme, type DrawnTheme, type ThemeMode } from "./design.js";
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
  ARTIFACT_ID_RE,
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
export { runningTail, type TurnEvent } from "./runningturn.js";
export { blocksIn, fenceAt, kindOfInfo, parseBlock, replaceBlocks, valueOf, valuesOf, type Fence, type KosBlock } from "./blocks.js";
export {
  BLOCK_KINDS,
  BLOCKS_GUIDANCE,
  CHANNEL_NAMES,
  blocksToText,
  checklistOf,
  copyOf,
  diffLineOf,
  icsOf,
  kindOf,
  mailtoOf,
  mapOf,
  plainOf,
  sendRequestOf,
  sendToolOf,
  sourceOf,
  stepsOf,
  viewOf,
  type BlockAction,
  type BlockKind,
  type BlockLink,
  type BlockRow,
  type BlockView,
  type BodyStyle,
  type CheckItem,
  type FieldSpec,
} from "./blockkinds.js";

export {
  ASK,
  AUTO_DECIDER,
  AUTO_NEVER,
  AUTO_SESSIONS,
  AUTO_SPANS,
  CHAT_MODES,
  cycled,
  leftWords,
  liveMode,
  MODE_WORDS,
  modeLabel,
  modeTip,
  nextMode,
  parseChatMode,
  spanOf,
  untilOf,
  type AutoSpan,
  type ChatMode,
  type ChatModeName,
} from "./chatmode.js";
export type {
  Cell as ViewCell,
  DocView,
  Frame as SlideFrame,
  OfficeView,
  Paragraph as SlideParagraph,
  PictureView,
  Run as SlideRun,
  Shape as SlideShape,
  Sheet as ViewSheet,
  SheetView,
  Slide,
  SlidesView,
  ViewFormat,
} from "./officeview.js";
export { bytesWords } from "./bytes.js";
export {
  isSearchKind,
  marksOfLetters,
  matchText,
  oneLine,
  queryWords,
  SEARCH_KINDS,
  SNIPPET_CHARS,
  snippetOf,
  type HitKind,
  type MatchQuality,
  type SearchHit,
  type SearchKind,
  type SearchResults,
  type SearchTarget,
  type Snippet,
  type TextMatch,
} from "./search.js";
export { assertName, checkName, NAME_MAX, NameError, nameRefusal, sameName, type FieldRefusal, type NameCheck, type NameProblem, type NameRules } from "./names.js";
export { stepLine, TOOL_WORDS, toolWords } from "./toolwords.js";
export { errorWords } from "./errorwords.js";
