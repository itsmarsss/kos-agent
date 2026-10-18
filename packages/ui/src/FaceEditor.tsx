import type { ReactElement } from "react";

import { ColourChoice } from "./ColourPicker.js";
import { hexOfHsl } from "./colour.js";
import { EYES, FILL_SAT, Face, fillOf, lightnessOf, lookOf, type FaceLook, type Gait } from "./Face.js";
import { Field } from "./kit.js";
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

/** The hex the picker shows for a hue: the blob's own body colour. */
export function hexOfHue(hue: number): string {
  return hexOfHsl(hue, FILL_SAT, lightnessOf(hue));
}

export function FaceEditor({ seed, value, onChange, label, preview = true }: FaceEditorProps): ReactElement {
  const shown = lookOf(seed, value);
  const custom = value.hue !== undefined || value.colour !== undefined || value.eyes !== undefined || value.gait !== undefined;
  const picked = shown.colour !== undefined;
  return (
    <div className="face-editor" style={{ "--blob-h": String(shown.hue) } as React.CSSProperties}>
      {preview && <Face seed={seed} look={value} size={64} label={label ?? `${seed}'s face`} />}
      <div className="face-editor-fields">
        <Field label="Colour" group className="face-editor-colour">
          {/* A swatch is a hue the face fills its own way; the picker gives
              it any colour as it is, and the hue for its accents. */}
          <ColourChoice
            value={shown.colour ?? hexOfHue(shown.hue)}
            swatchHue={shown.hue}
            picked={picked}
            fillOfHue={(hue) => fillOf(hue)}
            onSwatch={(hue) => {
              const { colour: _dropped, ...rest } = value;
              onChange({ ...rest, hue });
            }}
            onPick={(colour) => onChange({ ...value, colour })}
          />
        </Field>
        <Field label="Eyes">
          <Select
            className="settings-select"
            label="Eyes"
            value={shown.eyes}
            options={EYES.map((e) => ({ value: e, label: EYE_LABELS[e] ?? e }))}
            onChange={(eyes) => onChange({ ...value, eyes: EYES.find((e) => e === eyes) ?? "round" })}
          />
        </Field>
        <Field label="Gait">
          <Select className="settings-select" label="Gait" value={String(shown.wobble)} options={GAITS} onChange={(g) => onChange({ ...value, gait: Number(g) as Gait })} />
        </Field>
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
