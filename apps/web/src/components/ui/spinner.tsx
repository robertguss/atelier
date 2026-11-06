// Copied from T3 Code (https://github.com/pingdotgg/t3code), apps/web/src/components/ui/spinner.tsx.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.

import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import { LoaderCircleIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";

// No default size: inside a Button the parent's svg rule sizes the glyph.
const spinnerVariants = cva("motion-safe:visible-animate-spin", {
  defaultVariants: { tone: "current" },
  variants: {
    size: {
      lg: "size-5",
      md: "size-4",
      sm: "size-3.5",
      xs: "size-3",
    },
    tone: {
      current: "",
      muted: "text-muted-foreground",
    },
  },
});

const Spinner = ({
  className,
  size,
  tone,
  ...props
}: React.ComponentPropsWithoutRef<typeof LoaderCircleIcon> &
  VariantProps<typeof spinnerVariants>) => (
  <LoaderCircleIcon
    aria-label="Loading"
    ref={observeVisibleAnimation}
    className={cn(spinnerVariants({ size, tone }), className)}
    // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- The spinner is an SVG icon; an output element would add a wrapper around it.
    role="status"
    {...props}
  />
);

export { Spinner };
