import { useEffect, useState, type ReactElement } from "react";

import { hexOfHsl, SHAPE_WORD_MAX, shapeWordOf } from "@kos/shared";
import { DiceIcon, EYES, Face, type FaceLook, FILL_SAT, fillOf, type Gait, lightnessOf, lookOf } from "@kos/kit";

import { ColourChoice } from "./ColourPicker.js";
import { Field } from "./kit.js";
import { Select } from "./Select.js";

/**
 * The things the owner may set about a face, with the face beside them
 * changing as they do. Anything left to the name is shown as the name's,
 * and one press gives it all back to the name.
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

const CONSONANTS = "bdfgklmnprstvz";
const VOWELS = "aeiou";

/** A made-up word of two or three syllables, for a shape nobody has to think of. */
function anyWord(): string {
  const pick = (from: string): string => from[Math.floor(Math.random() * from.length)]!;
  let word = "";
  for (let i = 2 + Math.floor(Math.random() * 2); i > 0; i -= 1) word += pick(CONSONANTS) + pick(VOWELS);
  return word;
}

/** A look with its shape word, or without one. */
function withShape(value: FaceLook, word: string | undefined): FaceLook {
  const { shape: _given, ...rest } = value;
  return word ? { ...rest, shape: word } : rest;
}

/** The hex the picker shows for a hue: the blob's own body colour. */
export function hexOfHue(hue: number): string {
  return hexOfHsl(hue, FILL_SAT, lightnessOf(hue));
}

export function FaceEditor({ seed, value, onChange, label, preview = true }: FaceEditorProps): ReactElement {
  // The word as typed, drawn at once and kept when the owner is done with it.
  const [word, setWord] = useState(value.shape ?? "");
  useEffect(() => setWord(value.shape ?? ""), [value.shape]);
  const live = withShape(value, shapeWordOf(word));
  const keep = (): void => {
    const next = shapeWordOf(word);
    if (next !== value.shape) onChange(withShape(value, next));
  };
  const shown = lookOf(seed, live);
  const custom = value.hue !== undefined || value.colour !== undefined || value.eyes !== undefined || value.gait !== undefined || value.shape !== undefined;
  const picked = shown.colour !== undefined;
  return (
    <div className="face-editor" style={{ "--blob-h": String(shown.hue) } as React.CSSProperties}>
      {preview && <Face seed={seed} look={live} size={64} label={label ?? `${seed}'s face`} />}
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
        <Field label="Shape">
          {/* Any word grows its own outline; the same word, the same creature. */}
          <div className="face-editor-shape">
            <input
              className="kos-input"
              aria-label="Shape word"
              value={word}
              maxLength={SHAPE_WORD_MAX}
              placeholder="from the name"
              onChange={(e) => setWord(e.target.value)}
              onBlur={keep}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  keep();
                }
              }}
            />
            <button
              type="button"
              className="icon-btn"
              aria-label="Another shape"
              title="Another shape"
              onClick={() => {
                const next = anyWord();
                setWord(next);
                onChange(withShape(value, next));
              }}
            >
              <DiceIcon />
            </button>
          </div>
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
