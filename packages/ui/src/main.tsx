import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { domAnimation, LazyMotion, MotionConfig } from "motion/react";

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
        LazyMotion + domAnimation loads only the DOM animation features, which
        is roughly a third of the full bundle; `strict` makes an accidental
        `motion.*` import fail loudly instead of silently pulling the rest in.

        reducedMotion="user" honours the OS setting everywhere at once: motion
        keeps opacity changes and drops transforms, so nothing lurches for
        someone who asked for less movement.
      */}
      <LazyMotion features={domAnimation} strict>
        <MotionConfig reducedMotion="user">
          <App />
        </MotionConfig>
      </LazyMotion>
    </StrictMode>,
  );
}
