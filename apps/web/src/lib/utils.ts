// Adapted from T3 Code (https://github.com/pingdotgg/t3code), apps/web/src/lib/utils.ts:
// only `cn` is kept. Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.

import { cx } from "class-variance-authority";
import type { CxOptions } from "class-variance-authority";
import { extendTailwindMerge } from "tailwind-merge";

// Register the extra font sizes so tailwind-merge does not treat text-2xs as a color.
const twMerge = extendTailwindMerge({
  extend: {
    theme: { text: ["2xs", "3xs"] },
  },
});

export function cn(...inputs: CxOptions) {
  return twMerge(cx(inputs));
}
