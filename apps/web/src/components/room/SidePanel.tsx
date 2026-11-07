import type { LucideIcon } from "lucide-react";
import type { KeyboardEvent, PointerEvent, ReactNode, RefObject } from "react";

import { Badge } from "~/components/ui/badge";
import { hasContent } from "~/lib/utils";

// Either side panel may take at most this share of the room's width.
const PANEL_MAX_SHARE = 0.4;

const STEP = 24;

type Side = "left" | "right";

const borderFor = (side: Side) => (side === "left" ? "border-r" : "border-l");

// Arrow keys move the separator the way they point.
const arrowStep = (key: string) => {
  if (key === "ArrowRight") {
    return STEP;
  }
  return key === "ArrowLeft" ? -STEP : 0;
};

const captureSeparatorPointer = (e: PointerEvent<HTMLDivElement>) => {
  e.currentTarget.setPointerCapture(e.pointerId);
};

/** A folded side panel: a narrow strip that opens it, flagging what is waiting there. */
const PanelHandle = ({
  side,
  label,
  icon: Icon,
  badge,
  onClick,
}: {
  side: Side;
  label: string;
  icon: LucideIcon;
  badge: string | null;
  onClick: () => void;
}) => (
  <button
    type="button"
    aria-label={hasContent(badge) ? `${label}: ${badge}` : label}
    title={label}
    className={`bg-card/40 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:bg-accent flex w-10 shrink-0 cursor-pointer flex-col items-center gap-2 py-3 outline-none ${borderFor(side)}`}
    onClick={onClick}
  >
    <Icon className="size-4" />
    {hasContent(badge) ? (
      <Badge variant="info" className="[writing-mode:vertical-rl]">
        {badge}
      </Badge>
    ) : null}
  </button>
);

/** Drag or arrow keys resize the side panel on `side` of the document. */
const PanelSeparator = ({
  label,
  side,
  width,
  min,
  layoutRef,
  onWidth,
}: {
  label: string;
  side: Side;
  width: number;
  min: number;
  layoutRef: RefObject<HTMLDivElement | null>;
  onWidth: (update: (width: number) => number) => void;
}) => {
  const clamp = (next: number) => {
    const box = layoutRef.current?.getBoundingClientRect();
    const max =
      box && box.width > 0
        ? box.width * PANEL_MAX_SHARE
        : Number.POSITIVE_INFINITY;
    return Math.round(Math.max(min, Math.min(next, Math.max(min, max))));
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) {
      return;
    }
    const box = layoutRef.current?.getBoundingClientRect();
    if (!box) {
      return;
    }
    const next = side === "left" ? e.clientX - box.left : box.right - e.clientX;
    onWidth(() => clamp(next));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = arrowStep(e.key);
    if (step !== 0) {
      onWidth((w) => clamp(w + (side === "left" ? step : -step)));
    }
  };
  return (
    <div
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- A focusable, draggable splitter; hr is a void, non-interactive element.
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      tabIndex={0}
      className={`hover:bg-accent focus-visible:bg-accent w-1 shrink-0 cursor-col-resize bg-transparent ${borderFor(side)}`}
      onPointerDown={captureSeparatorPointer}
      onPointerMove={onPointerMove}
      onKeyDown={onKeyDown}
    />
  );
};

/**
 * A side panel beside the document: open, it is a resizable column; folded, it
 * is a strip that opens it. The panel stays mounted while folded, so what it
 * holds (a half-typed message, a scroll position) is still there when reopened.
 */
export const FoldablePane = ({
  side,
  open,
  width,
  min,
  layoutRef,
  onWidth,
  separatorLabel,
  handleLabel,
  handleIcon,
  badge,
  onOpen,
  children,
}: {
  side: Side;
  open: boolean;
  width: number;
  min: number;
  layoutRef: RefObject<HTMLDivElement | null>;
  onWidth: (update: (width: number) => number) => void;
  separatorLabel: string;
  handleLabel: string;
  handleIcon: LucideIcon;
  badge: string | null;
  onOpen: () => void;
  children: ReactNode;
}) => {
  const handle = open ? null : (
    <PanelHandle
      side={side}
      label={handleLabel}
      icon={handleIcon}
      badge={badge}
      onClick={onOpen}
    />
  );
  const separator = open ? (
    <PanelSeparator
      label={separatorLabel}
      side={side}
      width={width}
      min={min}
      layoutRef={layoutRef}
      onWidth={onWidth}
    />
  ) : null;
  const panel = (
    <aside hidden={!open} className="bg-card/40 shrink-0" style={{ width }}>
      {children}
    </aside>
  );
  return side === "left" ? (
    <>
      {handle}
      {panel}
      {separator}
    </>
  ) : (
    <>
      {separator}
      {panel}
      {handle}
    </>
  );
};
