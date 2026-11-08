import {
  cloneElement,
  useEffect,
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

interface Spot {
  left: number;
  top: number;
  below: boolean;
  arrow: number;
}

/** Closes the card open now, so a second one opening closes the first. */
let shown: (() => void) | null = null;

/** Where a card of `box`'s size goes for an element at `at`: above it, below when there is no room, inside the window. */
function spotFor(at: DOMRect, box: DOMRect): Spot {
  const middle = at.left + at.width / 2;
  const left = Math.max(EDGE, Math.min(middle - box.width / 2, window.innerWidth - box.width - EDGE));
  const below = at.top - GAP - box.height < EDGE;
  return {
    left,
    top: below ? at.bottom + GAP : at.top - GAP - box.height,
    below,
    arrow: Math.max(ARROW_INSET, Math.min(middle - left, box.width - ARROW_INSET)),
  };
}

/** What the card hands the element it points at. */
export interface TooltipAnchorProps {
  ref: Ref<HTMLElement>;
  /** Out of the tab order, so a long chat is not a tab stop per time; absent inside a link or button. */
  tabIndex: number | undefined;
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

/**
 * A small card over what it explains, as Discord shows a time.
 *
 * It opens at once under the pointer, and a tap toggles it where there is no
 * pointer to hover. It is no tab stop of its own, since a long chat would be
 * one per time, but focus that lands on it another way (a screen reader, a
 * script) opens it, as does focus on a link or button it sits inside, which
 * it then leaves the only focusable one. A press away or Escape closes it;
 * a scroll or resize carries it along with its element, and closes it only
 * when the element leaves the window. One is open at a time. It sits above
 * its element, below when there is no room above, and inside the window side
 * to side, its arrow on the element. It is drawn at the body, so a bubble
 * that clips its overflow does not cut it off.
 */
export function Tooltip({ tip, children }: TooltipProps): ReactElement {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [spot, setSpot] = useState<Spot | null>(null);
  const anchor = useRef<HTMLElement>(null);
  const card = useRef<HTMLDivElement>(null);
  // A tap focuses before it clicks; the click alone decides, so the focus is not taken as a keyboard's.
  const tapping = useRef(false);
  // The link or button the element sits inside, which takes focus in its place.
  const [host, setHost] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    setHost(anchor.current?.parentElement?.closest<HTMLElement>("a[href], button") ?? null);
  }, []);

  useEffect(() => {
    if (!host) return undefined;
    const show = (): void => setOpen(true);
    const hide = (): void => setOpen(false);
    host.addEventListener("focus", show);
    host.addEventListener("blur", hide);
    return () => {
      host.removeEventListener("focus", show);
      host.removeEventListener("blur", hide);
    };
  }, [host]);

  // Escape is heard last and passed on: a card the pointer merely rests on must not
  // swallow the Escape meant for the preview, drawer or dialog it sits in. A scroll
  // or resize moves the card with its element rather than closing it (below).
  useDismiss(open, () => setOpen(false), { inside: [anchor, card], escape: "dialog", scroll: false, resize: false });

  // One card at a time: opening this one closes whichever was open.
  useEffect(() => {
    if (!open) return undefined;
    const close = (): void => setOpen(false);
    shown?.();
    shown = close;
    return () => {
      if (shown === close) shown = null;
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setSpot(null);
      return undefined;
    }
    const place = (): void => {
      const at = anchor.current?.getBoundingClientRect();
      const box = card.current?.getBoundingClientRect();
      if (!at || !box) return;
      if (at.bottom < 0 || at.top > window.innerHeight || at.right < 0 || at.left > window.innerWidth) {
        setOpen(false);
        return;
      }
      setSpot(spotFor(at, box));
    };
    place();
    // A chat that streams scrolls itself under a resting pointer; the card follows, once a frame.
    let frame = 0;
    const moved = (): void => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        place();
      });
    };
    window.addEventListener("scroll", moved, true);
    window.addEventListener("resize", moved);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", moved, true);
      window.removeEventListener("resize", moved);
    };
  }, [open]);

  const touch = (event: PointerEvent<HTMLElement>): boolean => event.pointerType === "touch" || event.pointerType === "pen";

  const anchorProps: TooltipAnchorProps = {
    ref: anchor,
    tabIndex: host ? undefined : -1,
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
