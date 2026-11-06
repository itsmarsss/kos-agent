/**
 * The fonts an artifact may use. Its frame has no network, so KOS bundles a
 * small set of open-licensed (SIL OFL) families, latin only, and inlines the
 * ones an artifact names as data. Each comes with a fallback stack of faces
 * a machine already has, so text is never left in the browser's default.
 *
 * Chosen for range, not fashion: a reading serif, a book serif and a
 * high-contrast display serif; a neutral sans, two grotesques with character
 * and an expressive display sans; two monos. None is a default every
 * generated page already wears.
 */

export type FontRole = "serif" | "sans" | "mono";

export interface FontFile {
  /** Under dist/page-lib/fonts/. */
  file: string;
  style: "normal" | "italic";
  /** A weight, or a variable font's range: "400" or "200 800". */
  weight: string;
}

export interface ArtifactFont {
  id: string;
  family: string;
  role: FontRole;
  /** The CSS font-family value: the family, then faces that stand in for it. */
  stack: string;
  /** What it is good for, as the guide says it. */
  use: string;
  files: FontFile[];
}

const SERIF_FALLBACK = `"Iowan Old Style", "Charter", Georgia, "Times New Roman", serif`;
const SANS_FALLBACK = `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;
const MONO_FALLBACK = `ui-monospace, "SF Mono", Menlo, Consolas, monospace`;

const variable = (id: string, weight: string, italic: boolean): FontFile[] => [
  { file: `${id}-normal.woff2`, style: "normal", weight },
  ...(italic ? [{ file: `${id}-italic.woff2`, style: "italic" as const, weight }] : []),
];

export const ARTIFACT_FONTS: readonly ArtifactFont[] = [
  {
    id: "newsreader",
    family: "Newsreader",
    role: "serif",
    stack: `"Newsreader", ${SERIF_FALLBACK}`,
    use: "editorial reading serif with optical sizes: long documents, reports, memos",
    files: variable("newsreader", "200 800", true),
  },
  {
    id: "literata",
    family: "Literata",
    role: "serif",
    stack: `"Literata", ${SERIF_FALLBACK}`,
    use: "sturdy book serif: guides and dense text that is read on screens",
    files: variable("literata", "200 900", true),
  },
  {
    id: "bodoni-moda",
    family: "Bodoni Moda",
    role: "serif",
    stack: `"Bodoni Moda", "Didot", ${SERIF_FALLBACK}`,
    use: "high-contrast display serif: titles and large numbers only, never running text",
    files: variable("bodoni-moda", "400 900", true),
  },
  {
    id: "public-sans",
    family: "Public Sans",
    role: "sans",
    stack: `"Public Sans", ${SANS_FALLBACK}`,
    use: "neutral, legible sans: interface text, tables, captions, body text of a tool",
    files: variable("public-sans", "100 900", true),
  },
  {
    id: "hanken-grotesk",
    family: "Hanken Grotesk",
    role: "sans",
    stack: `"Hanken Grotesk", ${SANS_FALLBACK}`,
    use: "warm grotesque: dashboards and apps that want a little character",
    files: variable("hanken-grotesk", "100 900", true),
  },
  {
    id: "schibsted-grotesk",
    family: "Schibsted Grotesk",
    role: "sans",
    stack: `"Schibsted Grotesk", ${SANS_FALLBACK}`,
    use: "compact news grotesque: headings over a serif body, labels, dense UIs",
    files: variable("schibsted-grotesk", "400 900", true),
  },
  {
    id: "bricolage-grotesque",
    family: "Bricolage Grotesque",
    role: "sans",
    stack: `"Bricolage Grotesque", ${SANS_FALLBACK}`,
    use: "expressive display sans: slide titles, landing and showcase headings",
    files: variable("bricolage-grotesque", "200 800", false),
  },
  {
    id: "ibm-plex-mono",
    family: "IBM Plex Mono",
    role: "mono",
    stack: `"IBM Plex Mono", ${MONO_FALLBACK}`,
    use: "mono for figures, code and data labels",
    files: [
      { file: "ibm-plex-mono-400.woff2", style: "normal", weight: "400" },
      { file: "ibm-plex-mono-600.woff2", style: "normal", weight: "600" },
    ],
  },
  {
    id: "jetbrains-mono",
    family: "JetBrains Mono",
    role: "mono",
    stack: `"JetBrains Mono", ${MONO_FALLBACK}`,
    use: "taller mono for code blocks and terminal output",
    files: variable("jetbrains-mono", "100 800", false),
  },
];

export const fontById = (id: string): ArtifactFont | undefined => ARTIFACT_FONTS.find((f) => f.id === id);

/** The @font-face rules for the fonts named, given each file's bytes as base64. */
export function fontFaceCss(fonts: readonly ArtifactFont[], data: (file: string) => string | undefined): string {
  const rules: string[] = [];
  for (const font of fonts) {
    for (const f of font.files) {
      const b64 = data(f.file);
      if (!b64) continue;
      rules.push(`@font-face{font-family:"${font.family}";font-style:${f.style};font-weight:${f.weight};font-display:block;src:url(data:font/woff2;base64,${b64}) format("woff2")}`);
    }
  }
  return rules.join("\n");
}

/** The CSS variables naming each bundled stack, so an artifact can write var(--font-newsreader). */
export const fontStackVars = (): string => `:root{${ARTIFACT_FONTS.map((f) => `--font-${f.id}:${f.stack}`).join(";")}}`;
