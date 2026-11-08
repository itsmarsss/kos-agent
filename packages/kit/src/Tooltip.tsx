import {
  cloneElement,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import { createPortal } from "react-dom";

import { useDismiss } from "./useDismiss.js";

/** Space kept between the card and the window's edge, and between the card and what it points at. */
const EDGE = 8;
const GAP = 8;
/** How near the card's corner the arrow may go. */
const ARROW_INSET = 12;

/** What the card hands the element it points at. */
export interface TooltipAnchorProps {
  ref: Ref<HTMLElement>;
  tabIndex: number;
  "aria-describedby": string | undefined;
  onPointerEnter: (event: PointerEvent<HTMLElement>) => void;
  onPointerLeave: (event: PointerEvent<HTMLElement>) => void;
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onClick: () => void;
  onFocus: () => void;
  onBlur: () => void;
}

export interface TooltipProps {
  /** What the card says. */
  tip: ReactNode;
  /** The one element it points at, which takes the anchor's props: a ref, focus and the pointer. */
  children: ReactElement<TooltipAnchorProps>;
}

interface Spot {
  left: number;
  top: number;
  below: boolean;
  arrow: number;
}

/**
 * A small card over what it explains, as Discord shows a time.
 *
 * It opens at once under the pointer or on keyboard focus, and a tap toggles
 * it where there is no pointer to hover; a press away, a scroll or Escape
 * closes it. It sits above its element, below when there is no room above,
 * and inside the window side to side, its arrow on the element. It is drawn
 * at the body, so a bubble that clips its overflow does not cut it off.
 */
export function Tooltip({ tip, children }: TooltipProps): ReactElement {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [spot, setSpot] = useState<Spot | null>(null);
  const anchor = useRef<HTMLElement>(null);
  const card = useRef<HTMLDivElement>(null);
  // A tap focuses before it clicks; the click alone decides, so the focus is not taken as a keyboard's.
  const tapping = useRef(false);

  useDismiss(open, () => setOpen(false), { inside: [anchor, card] });

  useLayoutEffect(() => {
    if (!open) {
      setSpot(null);
      return;
    }
    const at = anchor.current?.getBoundingClientRect();
    const box = card.current?.getBoundingClientRect();
    if (!at || !box) return;
    const middle = at.left + at.width / 2;
    const left = Math.max(EDGE, Math.min(middle - box.width / 2, window.innerWidth - box.width - EDGE));
    const below = at.top - GAP - box.height < EDGE;
    setSpot({
      left,
      top: below ? at.bottom + GAP : at.top - GAP - box.height,
      below,
      arrow: Math.max(ARROW_INSET, Math.min(middle - left, box.width - ARROW_INSET)),
    });
  }, [open]);

  const touch = (event: PointerEvent<HTMLElement>): boolean => event.pointerType === "touch" || event.pointerType === "pen";

  const anchorProps: TooltipAnchorProps = {
    ref: anchor,
    tabIndex: 0,
    "aria-describedby": open ? id : undefined,
    onPointerEnter: (event) => {
      if (!touch(event)) setOpen(true);
    },
    onPointerLeave: (event) => {
      if (!touch(event)) setOpen(false);
    },
    onPointerDown: (event) => {
      tapping.current = touch(event);
    },
    onClick: () => {
      if (tapping.current) setOpen((was) => !was);
      tapping.current = false;
    },
    onFocus: () => {
      if (!tapping.current) setOpen(true);
    },
    onBlur: () => setOpen(false),
  };

  return (
    <>
      {cloneElement(children, anchorProps)}
      {open &&
        createPortal(
          <div
            ref={card}
            id={id}
            role="tooltip"
            className={`kos-tip${spot?.below ? " kos-tip--below" : ""}`}
            style={spot ? { left: spot.left, top: spot.top, ["--tip-arrow" as string]: `${spot.arrow}px` } : { left: 0, top: 0, visibility: "hidden" }}
          >
            {tip}
          </div>,
          document.body,
        )}
    </>
  );
}
