import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

/**
 * A popup placed below `anchor` that leaves focus where it is, for a menu
 * driven from the text the person is typing in.
 */
export const AnchoredPopover = ({
  anchor,
  onClose,
  className,
  children,
}: {
  anchor: PopoverPrimitive.Positioner.Props["anchor"];
  onClose: () => void;
  className?: string;
  children: ReactNode;
}) => (
  <PopoverPrimitive.Root
    open
    onOpenChange={(open) => {
      if (!open) {
        onClose();
      }
    }}
  >
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        anchor={anchor}
        side="bottom"
        align="start"
        sideOffset={4}
        className="z-50"
      >
        <PopoverPrimitive.Popup
          initialFocus={false}
          finalFocus={false}
          // The content carries its own role; this is only its frame.
          role="presentation"
          className={cn(
            "bg-popover text-popover-foreground rounded-lg border p-1 shadow-lg outline-none",
            className
          )}
        >
          {children}
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  </PopoverPrimitive.Root>
);
