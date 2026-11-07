// Copied from T3 Code (https://github.com/pingdotgg/t3code), apps/web/src/components/ui/empty.tsx.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.

import { cn } from "~/lib/utils";

const emptySizeClassName = {
  compact:
    "min-h-64 gap-4 p-6 md:p-10 [&_[data-slot=empty-media]]:mb-0 [&_[data-slot=empty-title]]:text-[1.0625rem] [&_[data-slot=empty-title]]:leading-6 [&_[data-slot=empty-description]]:text-[0.8125rem] [&_[data-slot=empty-description]]:leading-[1.125rem]",
  default: "gap-6 p-6 md:p-12",
  hero: "gap-6 p-6 md:p-12 [&_[data-slot=empty-title]]:text-2xl sm:[&_[data-slot=empty-title]]:text-3xl",
} as const;

const Empty = ({
  className,
  size = "default",
  ...props
}: React.ComponentProps<"div"> & {
  size?: keyof typeof emptySizeClassName;
}) => (
  <div
    className={cn(
      "flex min-w-0 flex-1 flex-col items-center justify-center text-center text-balance",
      emptySizeClassName[size],
      className
    )}
    data-slot="empty"
    {...props}
  />
);

const EmptyHeader = ({ className, ...props }: React.ComponentProps<"div">) => (
  <div
    className={cn("flex max-w-sm flex-col items-center text-center", className)}
    data-slot="empty-header"
    {...props}
  />
);

const EmptyTitle = ({ className, ...props }: React.ComponentProps<"div">) => (
  <div
    className={cn("text-xl font-semibold", className)}
    data-slot="empty-title"
    {...props}
  />
);

const EmptyDescription = ({
  className,
  ...props
}: React.ComponentProps<"p">) => (
  <div
    className={cn(
      "text-muted-foreground [&>a:hover]:text-primary text-sm [&>a]:underline [&>a]:underline-offset-4 [[data-slot=empty-description]+&]:mt-1 [[data-slot=empty-title]+&]:mt-1",
      className
    )}
    data-slot="empty-description"
    {...props}
  />
);

export { Empty, EmptyHeader, EmptyTitle, EmptyDescription };
