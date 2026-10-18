import type { ReactElement } from "react";

import { hexOfHsl, hueOfHex } from "./colour.js";
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
  const custom = value.hue !== undefined || value.eyes !== undefined || value.gait !== undefined;
  const onSwatch = SWATCHES.some((s) => s.hue === shown.hue);
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
                className={`swatch${shown.hue === s.hue ? " is-on" : ""}`}
                style={{ background: fillOf(s.hue) }}
                title={s.name}
                aria-label={s.name}
                aria-pressed={shown.hue === s.hue}
                onClick={() => onChange({ ...value, hue: s.hue })}
              />
            ))}
            {/* Any colour: the picker gives a hex, the face takes its hue and
                keeps its own saturation and lightness, so it stays a blob
                colour and not a mustard or a murk. */}
            <label className={`swatch-custom${onSwatch ? "" : " is-on"}`} title="Any colour">
              <span className="swatch swatch--rainbow" style={onSwatch ? undefined : { background: fillOf(shown.hue) }} aria-hidden="true" />
              <span>Custom</span>
              {!onSwatch && <code className="swatch-hex">{hexOfHue(shown.hue)}</code>}
              <input
                type="color"
                aria-label="Any colour"
                value={hexOfHue(shown.hue)}
                onChange={(e) => {
                  const hue = hueOfHex(e.target.value);
                  if (hue !== null) onChange({ ...value, hue });
                }}
              />
            </label>
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
