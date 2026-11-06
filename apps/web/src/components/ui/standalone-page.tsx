// Adapted from T3 Code (https://github.com/pingdotgg/t3code), apps/web/src/components/ui/standalone-page.tsx:
// the T3 Code wordmark is replaced with the Atelier name, and the description is a div so it can hold lists.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.

import type { ReactNode } from "react";

export function StandalonePage({ children }: { readonly children: ReactNode }) {
  return (
    // The page owns scrolling because root cannot scroll; safe centering keeps oversized cards top-aligned.
    <div className="bg-background text-foreground flex h-full items-center-safe justify-center overflow-y-auto px-4 py-10 sm:px-6">
      <section className="dialog-glass w-full max-w-xl rounded-2xl border p-6">
        {children}
      </section>
    </div>
  );
}

export function StandalonePageHeader({
  context,
  title,
  description,
}: {
  readonly context?: ReactNode;
  readonly title: ReactNode;
  readonly description: ReactNode;
}) {
  return (
    <>
      <div className="text-muted-foreground flex items-baseline justify-between gap-3">
        <span className="text-foreground text-lg font-medium tracking-tight">
          Atelier
        </span>
        {context ? <span className="text-sm">{context}</span> : null}
      </div>
      <h1 className="mt-6 text-xl leading-tight font-semibold">{title}</h1>
      <div className="text-muted-foreground mt-2 text-sm">{description}</div>
    </>
  );
}
