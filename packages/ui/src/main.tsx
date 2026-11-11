import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { domMax, LazyMotion, MotionConfig } from "motion/react";

import { App } from "./App.js";
import { AudienceWindow } from "./AudienceWindow.js";
import { audienceRoute } from "./presentlink.js";
import { applyDensity, applyTheme, followOtherTabs, readDensity, readTheme } from "./theme.js";
// The kit's pieces first, so the dashboard's own sheet says where a piece differs in its place; KaTeX's for typeset maths.
import "@kos/kit/kit.css";
import "@kos/kit/scrollbars.css";
import "katex/dist/katex.min.css";
import "./styles.css";

// Before the first paint, so a light-theme owner never sees a dark flash.
applyTheme(readTheme());
applyDensity(readDensity());
followOtherTabs();

// A deck's audience window is the dashboard's own page, drawn alone: no shell, no nav, the slide.
const audience = audienceRoute(window.location.hash);
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      {/*
        LazyMotion + domMax loads the DOM animation AND layout features, so
        shared-layout moves (layoutId) animate: the active-chat bar glides from
        one row to the next instead of snapping. `strict` makes an accidental
        `motion.*` import fail loudly instead of silently pulling the rest in.

        reducedMotion="user" honours the OS setting everywhere at once: motion
        keeps opacity changes and drops transforms, so nothing lurches for
        someone who asked for less movement.
      */}
      <LazyMotion features={domMax} strict>
        <MotionConfig reducedMotion="user">
          {audience ? <AudienceWindow {...audience} /> : <App />}
        </MotionConfig>
      </LazyMotion>
    </StrictMode>,
  );
}
