import type { ReactElement } from "react";

import { EYES, Face, lookOf, type FaceLook, type Gait } from "./Face.js";
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
}

const GAITS: { value: string; label: string }[] = [
  { value: "0", label: "steady" },
  { value: "1", label: "lively" },
  { value: "2", label: "slow" },
  { value: "3", label: "restless" },
];

export function FaceEditor({ seed, value, onChange, label }: FaceEditorProps): ReactElement {
  const shown = lookOf(seed, value);
  const custom = value.hue !== undefined || value.eyes !== undefined || value.gait !== undefined;
  return (
    <div className="face-editor">
      <Face seed={seed} look={value} size={64} label={label ?? `${seed}'s face`} />
      <div className="face-editor-fields">
        <label className="kos-field">
          <span className="kos-field-label">Colour</span>
          <input
            type="range"
            min={0}
            max={359}
            value={shown.hue}
            aria-label="Hue"
            onChange={(e) => onChange({ ...value, hue: Number(e.target.value) })}
          />
        </label>
        <label className="kos-field">
          <span className="kos-field-label">Eyes</span>
          <Select
            className="settings-select"
            label="Eyes"
            value={shown.eyes}
            options={EYES.map((e) => ({ value: e, label: e === "round" ? "dots" : e === "half" ? "pills" : "pills with a glint" }))}
            onChange={(eyes) => onChange({ ...value, eyes: (EYES.find((e) => e === eyes) ?? "round") })}
          />
        </label>
        <label className="kos-field">
          <span className="kos-field-label">Gait</span>
          <Select
            className="settings-select"
            label="Gait"
            value={String(shown.wobble)}
            options={GAITS}
            onChange={(g) => onChange({ ...value, gait: Number(g) as Gait })}
          />
        </label>
        <button type="button" className="btn btn--sm" disabled={!custom} onClick={() => onChange({})} title="Let the name decide again">
          Use the name's
        </button>
      </div>
    </div>
  );
}
