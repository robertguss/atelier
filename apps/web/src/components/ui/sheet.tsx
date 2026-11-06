// Adapted from T3 Code (https://github.com/pingdotgg/t3code), apps/web/src/components/ui/sheet.tsx:
// the retained-popup helpers it imports from dialog.tsx are inlined here.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.

import { Dialog as SheetPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import { createContext, use, useState } from "react";
import type { ComponentProps, CSSProperties, ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

const ControlledOpenContext = createContext<boolean | undefined>(undefined);

// oxlint-disable-next-line typescript/promise-function-async -- Returns its children, whose ReactNode type includes promises; a component cannot be async.
const RetainedWhileClosed = ({
  open,
  children,
}: {
  open: boolean;
  children: ReactNode;
}) => {
  const controlledOpen = use(ControlledOpenContext);
  const isOpen = open && controlledOpen !== false;
  const [retained, setRetained] = useState(children);
  if (isOpen && retained !== children) {
    setRetained(children);
  }
  return isOpen ? children : retained;
};

const renderRetainedPopup = (
  props: ComponentProps<"div">,
  state: { open: boolean }
) => (
  <div {...props}>
    <RetainedWhileClosed open={state.open}>
      {props.children}
    </RetainedWhileClosed>
  </div>
);

const Sheet = <Payload,>(props: SheetPrimitive.Root.Props<Payload>) => (
  <ControlledOpenContext value={props.open}>
    <SheetPrimitive.Root {...props} />
  </ControlledOpenContext>
);

const SheetPortal = SheetPrimitive.Portal;

const SheetBackdrop = ({
  className,
  ...props
}: SheetPrimitive.Backdrop.Props) => (
  <SheetPrimitive.Backdrop
    className={cn(
      "bg-background/60 fixed inset-0 z-(--z-sheet) backdrop-blur-xs transition-all duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0",
      className
    )}
    data-slot="sheet-backdrop"
    {...props}
  />
);

const SheetViewport = ({
  className,
  side,
  variant = "default",
  ...props
}: SheetPrimitive.Viewport.Props & {
  side?: "right" | "left" | "top" | "bottom";
  variant?: "default" | "inset";
}) => (
  <SheetPrimitive.Viewport
    className={cn(
      "fixed inset-0 z-(--z-sheet) grid",
      side === "bottom" && "grid grid-rows-[1fr_auto] pt-12",
      side === "top" && "grid grid-rows-[auto_1fr] pb-12",
      side === "left" && "flex justify-start",
      side === "right" && "flex justify-end",
      variant === "inset" && "sm:p-4",
      className
    )}
    data-slot="sheet-viewport"
    {...props}
  />
);

const SheetPopup = ({
  className,
  children,
  showCloseButton = true,
  keepMounted = false,
  transitionDurationMs,
  side = "right",
  variant = "default",
  style,
  ...props
}: SheetPrimitive.Popup.Props & {
  showCloseButton?: boolean;
  keepMounted?: boolean;
  transitionDurationMs?: number;
  side?: "right" | "left" | "top" | "bottom";
  variant?: "default" | "inset";
}) => {
  const transitionStyle =
    transitionDurationMs === undefined
      ? undefined
      : ({
          transitionDuration: `${transitionDurationMs}ms`,
        } satisfies CSSProperties);
  const instant = transitionDurationMs === 0;

  return (
    <SheetPortal keepMounted={keepMounted}>
      <SheetBackdrop
        className={
          instant
            ? "transition-none! data-ending-style:opacity-100! data-starting-style:opacity-100!"
            : undefined
        }
        style={transitionStyle}
      />
      <SheetViewport side={side} variant={variant}>
        <SheetPrimitive.Popup
          className={cn(
            "bg-popover text-popover-foreground relative flex max-h-full min-h-0 w-full min-w-0 flex-col shadow-lg/5 transition-[opacity,translate] duration-200 ease-in-out will-change-transform not-dark:bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:shadow-[0_1px_--theme(--color-black/4%)] data-ending-style:opacity-0 data-starting-style:opacity-0 max-sm:before:hidden dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
            side === "bottom" &&
              "row-start-2 border-t data-ending-style:translate-y-8 data-starting-style:translate-y-8",
            side === "top" &&
              "border-b data-ending-style:-translate-y-8 data-starting-style:-translate-y-8",
            side === "left" &&
              "w-[calc(100%-(--spacing(12)))] max-w-md border-e data-ending-style:-translate-x-8 data-starting-style:-translate-x-8",
            side === "right" &&
              "col-start-2 w-[calc(100%-(--spacing(12)))] max-w-md border-s data-ending-style:translate-x-8 data-starting-style:translate-x-8",
            variant === "inset" &&
              "before:hidden sm:rounded-2xl sm:border sm:before:rounded-[calc(var(--radius-2xl)-1px)] sm:**:data-[slot=sheet-footer]:rounded-b-[calc(var(--radius-2xl)-1px)]",
            instant &&
              "transition-none! will-change-auto! data-ending-style:translate-x-0! data-ending-style:translate-y-0! data-ending-style:opacity-100! data-starting-style:translate-x-0! data-starting-style:translate-y-0! data-starting-style:opacity-100!",
            className
          )}
          data-slot="sheet-popup"
          render={keepMounted ? undefined : renderRetainedPopup}
          // A style function has nothing to spread, so only a style object is merged.
          style={{
            ...transitionStyle,
            ...(typeof style === "function" ? {} : style),
          }}
          {...props}
        >
          {children}
          {showCloseButton && (
            <SheetPrimitive.Close
              aria-label="Close"
              className="absolute end-2 top-2"
              render={<Button size="icon" variant="ghost" />}
            >
              <XIcon />
            </SheetPrimitive.Close>
          )}
        </SheetPrimitive.Popup>
      </SheetViewport>
    </SheetPortal>
  );
};

const SheetHeader = ({ className, ...props }: React.ComponentProps<"div">) => (
  <div
    className={cn(
      "flex flex-col gap-2 p-6 in-[[data-slot=sheet-popup]:has([data-slot=sheet-panel])]:pb-3 max-sm:pb-4",
      className
    )}
    data-slot="sheet-header"
    {...props}
  />
);

const SheetTitle = ({ className, ...props }: SheetPrimitive.Title.Props) => (
  <SheetPrimitive.Title
    className={cn("text-xl leading-snug font-semibold", className)}
    data-slot="sheet-title"
    {...props}
  />
);

const SheetDescription = ({
  className,
  ...props
}: SheetPrimitive.Description.Props) => (
  <SheetPrimitive.Description
    className={cn("text-muted-foreground text-sm", className)}
    data-slot="sheet-description"
    {...props}
  />
);

export { Sheet, SheetPopup, SheetHeader, SheetTitle, SheetDescription };
