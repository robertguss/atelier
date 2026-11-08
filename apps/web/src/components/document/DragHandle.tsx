import { api } from "@atelier/backend/api";
import type { Id } from "@atelier/backend/dataModel";
import { useMutation } from "convex/react";
import { GripVerticalIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import type { DocBlock } from "~/lib/document";
import type { Session } from "~/lib/editor/session";

type Key = Id<"blocks">;

/** Asks a block's handle to take focus after a move; each is a new object. */
export interface HandleFocus {
  key: Key;
  at: number;
}

// A move can remount the block in another section, so a focus request
// outlives the old handle or editor. One older than this is not from an action
// just taken, and a block that remounts later must not take focus from
// wherever the person is.
export const FRESH_FOCUS_MS = 2000;
// How close to the scroller's top or bottom a drag scrolls it, and how far
// it scrolls per frame.
const EDGE_PX = 48;
const SCROLL_PX = 12;

/** Moves blocks on the server, then announces the new place and puts focus back on the moved block's handle. */
export const useBlockMoves = (session: Session<Key>) => {
  const moveTo = useMutation(api.blockOps.moveTo);
  const [announcement, setAnnouncement] = useState("");
  const [focus, setFocus] = useState<HandleFocus>();
  /** Moves the block at `from` among `blocks`, as shown, so it lands at `to`. */
  const move = async (
    blocks: readonly DocBlock[],
    from: number,
    to: number
  ) => {
    const moved = blocks[from];
    if (!moved || to === from) {
      return;
    }
    const after = blocks.filter((_, i) => i !== from)[to - 1];
    const key = session.keyOf(moved._id);
    const afterKey = after && session.keyOf(after._id);
    await session.run([[key, moved.rev]], async (find) => {
      const { id, rev } = find(key);
      const result = await moveTo({
        afterBlockId: afterKey === undefined ? null : find(afterKey).id,
        baseRev: rev,
        blockId: id,
      });
      return [[key, result.rev]];
    });
    setAnnouncement(`Moved to position ${to + 1} of ${blocks.length}`);
    setFocus({ at: Date.now(), key });
  };
  return { announcement, focus, move };
};

const scrollerOf = (element: Element) => {
  for (let at = element.parentElement; at; at = at.parentElement) {
    if (/auto|scroll/u.test(getComputedStyle(at).overflowY)) {
      return at;
    }
  }
  return document.documentElement;
};

const blockAt = (x: number, y: number) =>
  document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-block-id]") ??
  null;

// A pointer drag from a block's handle: marks the gap it would drop into,
// scrolls near the edges, and reports where the block lands among the others.
const startDrag = (
  handle: HTMLElement,
  start: { x: number; y: number },
  onDrop: (to: number) => void
) => {
  const self = handle.closest<HTMLElement>("[data-block-id]");
  const scroller = scrollerOf(handle);
  let { x, y } = start;
  let target: { block: HTMLElement; after: boolean } | null = null;
  let frame = 0;
  const unmark = () => {
    if (target) {
      delete target.block.dataset.drop;
    }
  };
  const mark = () => {
    unmark();
    target = null;
    const block = blockAt(x, y);
    if (block && block !== self) {
      const box = block.getBoundingClientRect();
      target = { after: y > box.top + box.height / 2, block };
      block.dataset.drop = target.after ? "after" : "before";
    }
  };
  const scroll = () => {
    const box = scroller.getBoundingClientRect();
    let step = 0;
    if (y < box.top + EDGE_PX) {
      step = -SCROLL_PX;
    } else if (y > box.bottom - EDGE_PX) {
      step = SCROLL_PX;
    }
    if (step !== 0) {
      scroller.scrollBy(0, step);
      mark();
    }
    frame = requestAnimationFrame(scroll);
  };
  const stop = () => {
    cancelAnimationFrame(frame);
    unmark();
  };
  return {
    // Dropped outside the blocks or on itself, the block stays put.
    drop: () => {
      const landed = target;
      stop();
      if (landed) {
        const others = [
          ...document.querySelectorAll<HTMLElement>("[data-block-id]"),
        ].filter((b) => b !== self);
        onDrop(others.indexOf(landed.block) + (landed.after ? 1 : 0));
      }
    },
    point: (px: number, py: number) => {
      x = px;
      y = py;
      mark();
      // Scrolling starts once the pointer moves, not on a press near an edge.
      if (frame === 0) {
        frame = requestAnimationFrame(scroll);
      }
    },
    stop,
  };
};

interface DragHandleProps {
  /** Who else is editing the block; they keep it in place. */
  holder: string | null;
  disabled: boolean;
  /** The block's place among `count` blocks, from 0. */
  position: number;
  count: number;
  /** Moves the block so it lands at `to` among the others. */
  onMove: (to: number) => void;
  focus: HandleFocus | undefined;
}

/** The handle that moves a block: drag it, or press Alt+Shift+Up or Down on it. */
export const DragHandle = ({
  holder,
  disabled,
  position,
  count,
  onMove,
  focus,
}: DragHandleProps) => {
  const ref = useRef<HTMLButtonElement>(null);
  const drag = useRef<ReturnType<typeof startDrag> | null>(null);
  // A drag reaches the latest blocks through this, not the ones it began on.
  const latest = useRef(onMove);
  useLayoutEffect(() => {
    latest.current = onMove;
  });
  useEffect(() => {
    if (focus && Date.now() - focus.at < FRESH_FOCUS_MS) {
      ref.current?.focus();
    }
  }, [focus]);
  useEffect(
    () => () => {
      drag.current?.stop();
    },
    []
  );
  const end = (how: "drop" | "stop") => {
    drag.current?.[how]();
    drag.current = null;
  };
  const label =
    holder === null ? "Reorder block" : `Reorder block, ${holder} is editing`;
  return (
    <Button
      ref={ref}
      size="icon-xs"
      variant="ghost-muted"
      aria-label={label}
      title={label}
      disabled={disabled}
      className="cursor-grab touch-none self-start opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 active:cursor-grabbing pointer-coarse:opacity-100"
      onPointerDown={(e) => {
        if (e.button !== 0 || drag.current) {
          return;
        }
        // No text selection while dragging.
        e.preventDefault();
        e.currentTarget.focus();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = startDrag(
          e.currentTarget,
          { x: e.clientX, y: e.clientY },
          (to) => {
            latest.current(to);
          }
        );
      }}
      onPointerMove={(e) => {
        drag.current?.point(e.clientX, e.clientY);
      }}
      onPointerUp={() => {
        end("drop");
      }}
      onPointerCancel={() => {
        end("stop");
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && drag.current) {
          end("stop");
          return;
        }
        const steps: Record<string, number> = { ArrowDown: 1, ArrowUp: -1 };
        const step = steps[e.key];
        if (!e.altKey || !e.shiftKey || step === undefined) {
          return;
        }
        e.preventDefault();
        const to = position + step;
        if (to >= 0 && to < count) {
          onMove(to);
        }
      }}
    >
      <GripVerticalIcon />
    </Button>
  );
};
