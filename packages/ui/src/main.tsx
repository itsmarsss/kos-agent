import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { domMax, LazyMotion, MotionConfig } from "motion/react";

import { App } from "./App.js";
import { applyDensity, applyTheme, readDensity, readTheme } from "./theme.js";
import "./styles.css";

// Before the first paint, so a light-theme owner never sees a dark flash.
applyTheme(readTheme());
applyDensity(readDensity());

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
          <App />
        </MotionConfig>
      </LazyMotion>
    </StrictMode>,
  );
}
