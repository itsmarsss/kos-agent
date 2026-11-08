/**
 * What chrome.page reads of the tab beside the side panel: where it is, what
 * the owner selected, and its text as it reads on screen. Run inside the page
 * by chrome.scripting, so it stands alone: nothing from outside its own body.
 */
export interface PageRead {
  url: string;
  title: string;
  selection: string;
  /** The page's headings in order, for an outline the model reads before its text. */
  headings: string[];
  text: string;
}

export function readPage(maxText: number): PageRead {
  const selection = String(getSelection() ?? "").trim().slice(0, 5_000);
  const text = (document.body?.innerText ?? "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const headings = [...document.querySelectorAll("h1, h2, h3")]
    .map((h) => (h as HTMLElement).innerText.replace(/\s+/g, " ").trim().slice(0, 160))
    .filter(Boolean)
    .slice(0, 40);
  return { url: location.href, title: document.title, selection, headings, text: text.slice(0, maxText) };
}
