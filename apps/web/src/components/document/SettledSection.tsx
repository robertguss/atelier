import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import type { DocThread } from "~/lib/document";
import type { Names, Participant } from "~/lib/room";
import { cn } from "~/lib/utils";

import { ThreadCard } from "./ThreadCard";

interface SettledSectionProps {
  threads: readonly DocThread[];
  names: Names;
  models: readonly Participant[];
}

/** Settled threads, folded away until someone expands them. */
export const SettledSection = ({
  threads,
  names,
  models,
}: SettledSectionProps) => {
  const [open, setOpen] = useState(false);
  return (
    <section aria-label="Settled threads" className="text-xs">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen((o) => !o);
        }}
        className="text-muted-foreground hover:text-foreground flex items-center gap-1"
      >
        <ChevronRightIcon
          className={cn("size-3.5 transition-transform", open && "rotate-90")}
        />
        Settled ({threads.length})
      </button>
      {open ? (
        <div className="mt-2 space-y-3">
          {threads.map((thread) => (
            <ThreadCard
              key={thread._id}
              thread={thread}
              names={names}
              models={models}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
};
