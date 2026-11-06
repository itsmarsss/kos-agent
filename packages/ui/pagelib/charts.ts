// The charts library a page names, as a global: a page has no build step and no imports.
import { bar, line, pie } from "./chartdraw.js";

Object.assign(window, { KosCharts: { bar, line, pie } });
