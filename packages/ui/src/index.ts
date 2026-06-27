/**
 * @kos/ui
 *
 * The fixed React shell (dashboard) plus the widget library and page-spec
 * renderer. The agent authors pages as JSON specs; PageRenderer renders them
 * from a fixed widget set behind per-page and per-widget error boundaries.
 */
export { App } from "./App.js";
export { PageRenderer, type PageRendererProps } from "./widgets/PageRenderer.js";
export { ErrorBoundary } from "./widgets/ErrorBoundary.js";
export { widgetRenderer, type Row, type WidgetProps } from "./widgets/widgets.js";
