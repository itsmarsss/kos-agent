import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";
import { createPortal } from "react-dom";

import { hexOfHsv, hsvOfHex, type Hsv } from "./colour.js";
import { useAnchoredPop } from "./kit.js";

/**
 * A colour picker of KOS's own: a square of saturation and value under a
 * strip of hue, with the hex beside them. The browser's picker is the
 * operating system's, a window of its own that looks nothing like the
 * page; this one sits where it is opened and reads as part of it.
 */

export interface ColourPickerProps {
  /** The colour as hex, #rrggbb. */
  value: string;
  onChange: (hex: string) => void;
  label?: string;
}

function clamp(n: number): number {
  return Math.min(1, Math.max(0, n));
}

export function ColourPicker({ value, onChange, label = "Colour" }: ColourPickerProps): ReactElement {
  // Held as HSV so a drag along the strip keeps the hue when the square
  // sits on a grey, where hex alone would forget it.
  const [hsv, setHsv] = useState<Hsv>(() => hsvOfHex(value) ?? { h: 214, s: 84, v: 90 });
  const [typed, setTyped] = useState(value);
  const square = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);

  // A new value from outside (a swatch pressed, the name taking over) is adopted.
  useEffect(() => {
    if (value.toLowerCase() === hexOfHsv(hsv).toLowerCase()) return;
    const next = hsvOfHex(value, hsv.h);
    if (next) setHsv(next);
    setTyped(value);
    // Only when the value changes under us; hsv is ours.
  }, [value]);

  const commit = (next: Hsv): void => {
    setHsv(next);
    const hex = hexOfHsv(next);
    setTyped(hex);
    onChange(hex);
  };

  const fromSquare = (e: ReactPointerEvent): void => {
    const box = square.current?.getBoundingClientRect();
    if (!box) return;
    commit({ ...hsv, s: Math.round(clamp((e.clientX - box.left) / box.width) * 100), v: Math.round((1 - clamp((e.clientY - box.top) / box.height)) * 100) });
  };
  const fromStrip = (e: ReactPointerEvent): void => {
    const box = strip.current?.getBoundingClientRect();
    if (!box) return;
    commit({ ...hsv, h: Math.round(clamp((e.clientX - box.left) / box.width) * 359) });
  };
  /** Press, then drag: the pointer is captured so a drag past the edge still counts. */
  const drag = (read: (e: ReactPointerEvent) => void) => ({
    onPointerDown: (e: ReactPointerEvent) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      read(e);
    },
    onPointerMove: (e: ReactPointerEvent) => {
      if (e.buttons & 1) read(e);
    },
  });

  const pure = `hsl(${hsv.h} 100% 50%)`;
  return (
    <div className="cpick" role="group" aria-label={label}>
      <div
        ref={square}
        className="cpick-square"
        style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${pure})` }}
        aria-hidden="true"
        {...drag(fromSquare)}
      >
        <span className="cpick-thumb" style={{ left: `${hsv.s}%`, top: `${100 - hsv.v}%`, background: hexOfHsv(hsv) }} />
      </div>
      <div ref={strip} className="cpick-strip" aria-hidden="true" {...drag(fromStrip)}>
        <span className="cpick-thumb" style={{ left: `${(hsv.h / 359) * 100}%`, top: "50%", background: pure }} />
      </div>
      <div className="cpick-foot">
        <span className="cpick-swatch" style={{ background: hexOfHsv(hsv) }} aria-hidden="true" />
        <input
          className="kos-input cpick-hex"
          aria-label={`${label} as hex`}
          value={typed}
          spellCheck={false}
          onChange={(e) => {
            const text = e.target.value;
            setTyped(text);
            const next = hsvOfHex(text, hsv.h);
            if (next) {
              setHsv(next);
              onChange(hexOfHsv(next));
            }
          }}
          onBlur={() => setTyped(hexOfHsv(hsv))}
        />
        <input type="range" className="cpick-hue" aria-label="Hue" min={0} max={359} value={hsv.h} onChange={(e) => commit({ ...hsv, h: Number(e.target.value) })} />
      </div>
    </div>
  );
}

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

export interface ColourChoiceProps {
  /** The colour worn now, as hex. */
  value: string;
  /** The swatch hue worn, when the colour is a swatch's and not a picked one. */
  swatchHue?: number;
  /** Each swatch's fill, so a face's swatches are matte blob colours and a project's are plain. */
  fillOfHue: (hue: number) => string;
  /** A swatch was pressed, by hue; or the picker gave a colour. */
  onSwatch: (hue: number) => void;
  onPick: (hex: string) => void;
  /** The colour was picked rather than a swatch's, so Custom wears it. */
  picked: boolean;
}

/**
 * The swatches and the Custom pill with the picker behind it, as the face
 * editor has them, for anything that can be given a colour: a face, a
 * project. The popover is fixed to the viewport so no card or modal clips it.
 */
export function ColourChoice({ value, swatchHue, fillOfHue, onSwatch, onPick, picked }: ColourChoiceProps): ReactElement {
  const { at, open, toggle, wrap, pop } = useAnchoredPop({ width: 240, height: 260 });
  return (
    <div className="swatches">
      {SWATCHES.map((s) => (
        <button
          key={s.hue}
          type="button"
          className={`swatch${!picked && swatchHue === s.hue ? " is-on" : ""}`}
          style={{ background: fillOfHue(s.hue) }}
          title={s.name}
          aria-label={s.name}
          aria-pressed={!picked && swatchHue === s.hue}
          onClick={() => onSwatch(s.hue)}
        />
      ))}
      <div className="swatch-custom-wrap" ref={wrap}>
        <button type="button" className={`swatch-custom${picked ? " is-on" : ""}`} title="Any colour" aria-expanded={open} onClick={toggle}>
          {/* Empty until a colour is picked: a dashed ring, then the colour. */}
          <span className={`swatch swatch--any${picked ? " is-set" : ""}`} style={picked ? { background: value } : undefined} aria-hidden="true" />
          <span>Custom</span>
          {picked && <code className="swatch-hex">{value}</code>}
        </button>
        {at &&
          createPortal(
            <div className="kos-pop cpick-pop" ref={pop} style={{ top: at.top, left: at.left }}>
              <ColourPicker value={value} onChange={onPick} />
            </div>,
            document.body,
          )}
      </div>
    </div>
  );
}
