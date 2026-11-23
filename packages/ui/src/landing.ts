/**
 * Where the keys land on a page just arrived at: its heading, so a screen
 * reader says which page this is and reads on from its top; the page's
 * region when it has no heading yet (still loading). A heading is not a
 * tab stop, so it takes the focus by script only (tabIndex -1).
 */
export function landOnHeading(root: ParentNode = document): void {
  const heading = root.querySelector<HTMLElement>(".ops-page h1");
  if (heading) {
    if (!heading.hasAttribute("tabindex")) heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
    return;
  }
  root.querySelector<HTMLElement>("[data-focus-home]")?.focus({ preventScroll: true });
}
