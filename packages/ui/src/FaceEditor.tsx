import { useEffect, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";

import { ColourPicker } from "./ColourPicker.js";
import { hexOfHsl } from "./colour.js";
import { EYES, FILL_SAT, Face, fillOf, lightnessOf, lookOf, type FaceLook, type Gait } from "./Face.js";
import { Select } from "./Select.js";

/**
 * The three things the owner may set about a face, with the face beside
 * them changing as they do. Anything left to the name is shown as the
 * name's, and one press gives it all back to the name.
 */

export interface FaceEditorProps {
  /** The name the unset parts come from. */
  seed: string;
  value: FaceLook;
  onChange: (next: FaceLook) => void;
  label?: string;
  /** Without the face itself, for a form that draws it elsewhere. */
  preview?: boolean;
}

const GAITS: { value: string; label: string }[] = [
  { value: "0", label: "steady" },
  { value: "1", label: "lively" },
  { value: "2", label: "slow" },
  { value: "3", label: "restless" },
];

const EYE_LABELS: Record<string, string> = { round: "dots", half: "pills", sparkle: "pills with a glint" };

/** A quick pick around the wheel; the picker is for anything between. */
export const SWATCHES: { hue: number; name: string }[] = [
  { hue: 0, name: "red" },
  { hue: 24, name: "orange" },
  { hue: 48, name: "amber" },
  { hue: 90, name: "lime" },
  { hue: 150, name: "green" },
  { hue: 180, name: "teal" },
  { hue: 214, name: "blue" },
  { hue: 250, name: "indigo" },
  { hue: 285, name: "violet" },
  { hue: 330, name: "pink" },
];

/** The hex the picker shows for a hue: the blob's own body colour. */
export function hexOfHue(hue: number): string {
  return hexOfHsl(hue, FILL_SAT, lightnessOf(hue));
}

export function FaceEditor({ seed, value, onChange, label, preview = true }: FaceEditorProps): ReactElement {
  const shown = lookOf(seed, value);
  const custom = value.hue !== undefined || value.colour !== undefined || value.eyes !== undefined || value.gait !== undefined;
  const picked = shown.colour !== undefined;
  /** Where the picker sits, fixed to the viewport, so no card or modal clips it. */
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const open = at !== null;

  const toggle = (): void => {
    if (at) {
      setAt(null);
      return;
    }
    const box = wrap.current?.getBoundingClientRect();
    if (!box) return;
    const height = 260;
    const width = 240;
    const below = box.bottom + 6 + height <= window.innerHeight;
    setAt({ top: below ? box.bottom + 6 : Math.max(8, box.top - 6 - height), left: Math.min(box.left, Math.max(8, window.innerWidth - width - 8)) });
  };

  // The picker closes on a press outside it, on Escape, or when the page moves under it, like a menu.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent): void => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !wrap.current?.contains(t)) setAt(null);
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setAt(null);
    };
    const moved = (e: Event): void => {
      if (!pop.current?.contains(e.target as Node)) setAt(null);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", moved);
    document.addEventListener("scroll", moved, true);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
      window.removeEventListener("resize", moved);
      document.removeEventListener("scroll", moved, true);
    };
  }, [open]);

  return (
    <div className="face-editor" style={{ "--blob-h": String(shown.hue) } as React.CSSProperties}>
      {preview && <Face seed={seed} look={value} size={64} label={label ?? `${seed}'s face`} />}
      <div className="face-editor-fields">
        <div className="kos-field face-editor-colour" role="group" aria-label="Colour">
          <span className="kos-field-label">Colour</span>
          <div className="swatches">
            {SWATCHES.map((s) => (
              <button
                key={s.hue}
                type="button"
                className={`swatch${!picked && shown.hue === s.hue ? " is-on" : ""}`}
                style={{ background: fillOf(s.hue) }}
                title={s.name}
                aria-label={s.name}
                aria-pressed={!picked && shown.hue === s.hue}
                onClick={() => {
                  const { colour: _dropped, ...rest } = value;
                  onChange({ ...rest, hue: s.hue });
                }}
              />
            ))}
            {/* Any colour at all, from a picker of the page's own; the face
                wears it as it is, and takes its hue for the accents. */}
            <div className="swatch-custom-wrap" ref={wrap}>
              <button type="button" className={`swatch-custom${picked ? " is-on" : ""}`} title="Any colour" aria-expanded={open} onClick={toggle}>
                <span className="swatch swatch--rainbow" style={picked ? { background: shown.fill } : undefined} aria-hidden="true" />
                <span>Custom</span>
                {picked && <code className="swatch-hex">{shown.colour}</code>}
              </button>
              {at &&
                createPortal(
                  <div className="cpick-pop" ref={pop} style={{ top: at.top, left: at.left }}>
                    <ColourPicker value={shown.colour ?? hexOfHue(shown.hue)} onChange={(colour) => onChange({ ...value, colour })} />
                  </div>,
                  document.body,
                )}
            </div>
          </div>
        </div>
        <label className="kos-field">
          <span className="kos-field-label">Eyes</span>
          <Select
            className="settings-select"
            label="Eyes"
            value={shown.eyes}
            options={EYES.map((e) => ({ value: e, label: EYE_LABELS[e] ?? e }))}
            onChange={(eyes) => onChange({ ...value, eyes: EYES.find((e) => e === eyes) ?? "round" })}
          />
        </label>
        <label className="kos-field">
          <span className="kos-field-label">Gait</span>
          <Select className="settings-select" label="Gait" value={String(shown.wobble)} options={GAITS} onChange={(g) => onChange({ ...value, gait: Number(g) as Gait })} />
        </label>
        <div className="face-editor-foot">
          <span className="hint">{custom ? "Set by hand; the rest comes from the name." : "All of it comes from the name."}</span>
          {custom && (
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => onChange({})} title="Let the name decide again">
              From the name
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
