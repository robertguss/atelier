// Copied from T3 Code (https://github.com/pingdotgg/t3code), apps/web/src/components/ui/textarea.tsx.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.

import { Field as FieldPrimitive } from "@base-ui/react/field";
import { mergeProps } from "@base-ui/react/merge-props";
import type * as React from "react";

import { cn } from "~/lib/utils";

type TextareaProps = React.ComponentProps<"textarea"> & {
  size?: "sm" | "default" | "lg" | number;
  unstyled?: boolean;
};

// Vertical padding of each size, in spacing units.
const paddingSpacing = (size: TextareaProps["size"]) => {
  if (size === "sm") {
    return 1;
  }
  if (size === "lg") {
    return 2;
  }
  return 1.5;
};

const Textarea = ({
  className,
  size = "default",
  unstyled = false,
  rows,
  ...props
}: TextareaProps) => (
  <span
    className={
      cn(
        !unstyled &&
          "border-input bg-background text-foreground ring-ring/24 has-focus-visible:has-aria-invalid:border-destructive/64 has-focus-visible:has-aria-invalid:ring-destructive/16 has-aria-invalid:border-destructive/36 has-focus-visible:border-ring dark:bg-input/32 dark:has-aria-invalid:ring-destructive/24 relative inline-flex w-full rounded-lg border text-base shadow-xs/5 transition-shadow not-dark:bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] not-has-disabled:has-not-focus-visible:not-has-aria-invalid:before:shadow-[0_1px_--theme(--color-black/4%)] has-focus-visible:ring-[3px] has-focus-visible:ring-inset has-disabled:opacity-64 has-[:disabled,:focus-visible,[aria-invalid]]:shadow-none sm:text-sm dark:not-has-disabled:has-not-focus-visible:not-has-aria-invalid:before:shadow-[0_-1px_--theme(--color-white/6%)]",
        className
      ) || undefined
    }
    data-size={size}
    data-slot="textarea-control"
  >
    <FieldPrimitive.Control
      render={(defaultProps) => (
        <textarea
          className={cn(
            "field-sizing-content max-h-64 w-full rounded-[inherit] px-[calc(--spacing(3)-1px)] py-[calc(--spacing(1.5)-1px)] wrap-anywhere outline-none",
            rows === undefined && "min-h-17.5 max-sm:min-h-20.5",
            size === "sm" &&
              "px-[calc(--spacing(2.5)-1px)] py-[calc(--spacing(1)-1px)]",
            size === "sm" &&
              rows === undefined &&
              "min-h-16.5 max-sm:min-h-19.5",
            size === "lg" && "py-[calc(--spacing(2)-1px)]",
            size === "lg" &&
              rows === undefined &&
              "min-h-18.5 max-sm:min-h-21.5"
          )}
          // field-sizing: content ignores `rows`, so an explicit row count sets the minimum height.
          style={
            rows === undefined
              ? undefined
              : {
                  minHeight: `calc(${rows}lh + 2 * (var(--spacing) * ${paddingSpacing(size)} - 1px))`,
                }
          }
          data-slot="textarea"
          rows={rows}
          {...mergeProps(defaultProps, props)}
        />
      )}
    />
  </span>
);

export { Textarea };
