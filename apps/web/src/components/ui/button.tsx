// Copied from T3 Code (https://github.com/pingdotgg/t3code), apps/web/src/components/ui/button.tsx.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "~/lib/utils";

const buttonVariants = cva(
  "focus-visible:ring-ring focus-visible:ring-offset-background relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-[var(--control-radius)] border text-base font-medium whitespace-nowrap transition-[box-shadow,scale] outline-none [--control-icon-color:currentColor] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--control-radius)-1px)] focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-64 aria-disabled:cursor-not-allowed aria-disabled:opacity-64 sm:text-sm pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 [&_svg]:pointer-events-none [&_svg]:-mx-0.5 [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-[var(--control-icon-color)] [&:active:not([aria-haspopup])]:scale-[0.97] [&:not([aria-haspopup]):not(:disabled):not([aria-disabled=true])]:will-change-[scale]",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        compact:
          "h-7 gap-1 rounded-md px-[calc(--spacing(2)-1px)] text-xs before:rounded-[calc(var(--radius-md)-1px)] [&_svg:not([class*='size-'])]:size-3.5",
        default: "h-9 px-[calc(--spacing(3)-1px)] sm:h-8",
        icon: "size-9 sm:size-8",
        "icon-lg": "size-10 sm:size-9",
        "icon-micro":
          "size-5 rounded-sm p-0 before:rounded-[calc(var(--radius-sm)-1px)] [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8 sm:size-7",
        "icon-sm-pill": "size-8 rounded-full before:rounded-full sm:size-7",
        "icon-tiny": "size-4 p-0 [&_svg:not([class*='size-'])]:size-3",
        "icon-xl":
          "size-11 sm:size-10 [&_svg:not([class*='size-'])]:size-5 sm:[&_svg:not([class*='size-'])]:size-4.5",
        "icon-xs":
          "size-7 sm:size-6 not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-4 sm:not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-10 px-[calc(--spacing(3.5)-1px)] sm:h-9",
        micro:
          "h-5 gap-1 rounded-sm px-[calc(--spacing(1.5)-1px)] text-[11px] before:rounded-[calc(var(--radius-sm)-1px)] sm:text-[11px] [&_svg:not([class*='size-'])]:size-3 sm:[&_svg:not([class*='size-'])]:size-3",
        multiline:
          "min-h-9 px-[calc(--spacing(3)-1px)] py-[calc(--spacing(1.5)-1px)] whitespace-normal sm:min-h-8",
        sm: "h-8 gap-1.5 px-[calc(--spacing(2.5)-1px)] sm:h-7",
        "sm-multiline":
          "min-h-8 gap-1.5 px-[calc(--spacing(2.5)-1px)] py-[calc(--spacing(1)-1px)] whitespace-normal sm:min-h-7",
        "sm-pill": "h-8 gap-1.5 rounded-full px-2.5 sm:h-7",
        xl: "h-11 px-[calc(--spacing(4)-1px)] text-lg sm:h-10 sm:text-base [&_svg:not([class*='size-'])]:size-5 sm:[&_svg:not([class*='size-'])]:size-4.5",
        xs: "h-7 gap-1 px-[calc(--spacing(2)-1px)] text-sm sm:h-6 sm:text-xs [&_svg:not([class*='size-'])]:size-4 sm:[&_svg:not([class*='size-'])]:size-3.5",
      },
      variant: {
        default:
          "border-primary bg-primary text-primary-foreground shadow-primary/24 [:hover,[data-pressed]]:bg-primary/90 shadow-xs not-disabled:inset-shadow-[0_1px_--theme(--color-white/16%)] [:active,[data-pressed]]:inset-shadow-[0_1px_--theme(--color-black/8%)] [:disabled,:active,[data-pressed]]:shadow-none",
        destructive:
          "border-destructive bg-destructive shadow-destructive/24 [:hover,[data-pressed]]:bg-destructive/90 text-white shadow-xs not-disabled:inset-shadow-[0_1px_--theme(--color-white/16%)] [:active,[data-pressed]]:inset-shadow-[0_1px_--theme(--color-black/8%)] [:disabled,:active,[data-pressed]]:shadow-none",
        "destructive-outline":
          "border-input bg-popover text-destructive-foreground dark:bg-input/32 [:hover,[data-pressed]]:border-destructive/32 [:hover,[data-pressed]]:bg-destructive/4 shadow-xs/5 not-dark:bg-clip-padding not-disabled:not-active:not-data-pressed:before:shadow-[0_1px_--theme(--color-black/4%)] dark:not-disabled:before:shadow-[0_-1px_--theme(--color-white/2%)] dark:not-disabled:not-active:not-data-pressed:before:shadow-[0_-1px_--theme(--color-white/6%)] [:disabled,:active,[data-pressed]]:shadow-none",
        ghost:
          "text-foreground data-pressed:bg-accent [:hover,[data-pressed]]:bg-accent border-transparent [--control-icon-color:var(--contrast-muted-foreground)]",
        "ghost-destructive":
          "text-muted-foreground data-pressed:bg-accent [:hover,[data-pressed]]:bg-accent [:hover,[data-pressed]]:text-destructive border-transparent [--control-icon-color:currentColor]",
        "ghost-muted":
          "text-muted-foreground data-pressed:bg-accent [:hover,[data-pressed]]:bg-accent [:hover,[data-pressed]]:text-foreground border-transparent [--control-icon-color:currentColor]",
        glass:
          "surface-glass border-border/60 text-foreground [:hover,[data-pressed]]:border-border rounded-full shadow-sm [--control-icon-color:var(--contrast-muted-foreground)] before:rounded-full",
        link: "border-transparent underline-offset-4 [:hover,[data-pressed]]:underline",
        "media-close":
          "border-transparent bg-black/65 text-white shadow-sm ring-1 ring-white/20 [--control-icon-color:currentColor] focus-visible:ring-white [:hover,[data-pressed]]:bg-black/80",
        "media-navigation":
          "absolute top-1/2 z-20 -translate-y-1/2 border-transparent text-white/90 [--control-icon-color:currentColor] focus-visible:ring-white focus-visible:ring-offset-transparent [:hover,[data-pressed]]:bg-white/10 [:hover,[data-pressed]]:text-white",
        outline:
          "border-input bg-popover text-foreground dark:bg-input/32 [:hover,[data-pressed]]:bg-accent/50 dark:[:hover,[data-pressed]]:bg-input/64 shadow-xs/5 [--control-icon-color:var(--contrast-muted-foreground)] not-dark:bg-clip-padding not-disabled:not-active:not-data-pressed:before:shadow-[0_1px_--theme(--color-black/4%)] dark:not-disabled:before:shadow-[0_-1px_--theme(--color-white/2%)] dark:not-disabled:not-active:not-data-pressed:before:shadow-[0_-1px_--theme(--color-white/6%)] [:disabled,:active,[data-pressed]]:shadow-none",
        overlay:
          "border-transparent bg-black/70 text-white/65 [:hover,[data-pressed]]:bg-black/90",
        secondary:
          "bg-secondary text-secondary-foreground [:active,[data-pressed]]:bg-secondary/80 [:hover,[data-pressed]]:bg-secondary/90 border-transparent",
        "warning-outline":
          "border-warning/32 bg-warning-surface text-warning-foreground [:hover,[data-pressed]]:border-warning/40 [:hover,[data-pressed]]:bg-warning/16 dark:[:hover,[data-pressed]]:bg-warning/24 shadow-xs/5 [:disabled,:active,[data-pressed]]:shadow-none",
      },
    },
  }
);

type ButtonVariant = NonNullable<
  VariantProps<typeof buttonVariants>["variant"]
>;
type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>["size"]>;

interface ButtonProps extends useRender.ComponentProps<"button"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const Button = ({
  className,
  variant,
  size,
  render,
  ...props
}: ButtonProps) => {
  const typeValue: React.ButtonHTMLAttributes<HTMLButtonElement>["type"] =
    render ? undefined : "button";

  const defaultProps = {
    className: cn(buttonVariants({ className, size, variant })),
    "data-slot": "button",
    type: typeValue,
  };

  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  });
};

export { Button };
