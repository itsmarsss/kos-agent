// React for an HTML page, as globals: a page has no build step and no imports.
import * as React from "react";
import * as ReactDOM from "react-dom/client";

Object.assign(window, { React, ReactDOM, h: React.createElement });
