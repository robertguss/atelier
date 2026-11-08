import { numberedPositions } from "@atelier/shared";

import { authorText, MARK_LABEL } from "~/lib/document";
import type { BlockMark, VersionBlock } from "~/lib/document";
import type { Names } from "~/lib/room";
import { cn } from "~/lib/utils";

import { BlockEditor } from "./BlockEditor";

const MARK_STYLE: Record<BlockMark, string> = {
  added: "bg-success/10 ring-success/40",
  changed: "bg-info/10 ring-info/40",
  commented: "bg-warning/12 ring-warning/40",
  moved: "bg-info/6 ring-info/30",
  removed:
    "bg-destructive/8 ring-destructive/30 [&_[data-block-body]]:line-through [&_[data-block-body]]:opacity-70",
};

export type MarkedBlock = VersionBlock & { mark: BlockMark | null };

/** An earlier version of the document, read-only, with any marked blocks set apart. */
export const VersionView = ({
  blocks,
  names,
}: {
  blocks: readonly MarkedBlock[];
  names: Names;
}) => {
  if (blocks.length === 0) {
    return (
      <p className="text-muted-foreground px-2 py-1.5 text-sm">
        The document was empty.
      </p>
    );
  }
  const numbers = numberedPositions(blocks.map((b) => b.kind));
  return (
    <div className="space-y-1">
      {blocks.map((block, i) => (
        <div
          key={block.blockId}
          data-version-block=""
          data-mark={block.mark ?? undefined}
          className={cn(
            "px-2 py-1.5",
            block.mark && cn("rounded-lg ring-1", MARK_STYLE[block.mark])
          )}
        >
          <div data-block-body="" className="flex items-baseline gap-2">
            {block.kind === "todo" ? (
              <input
                type="checkbox"
                checked={block.checked ?? false}
                disabled
                readOnly
                aria-label={block.text || "To-do"}
                className="accent-primary translate-y-0.5"
              />
            ) : null}
            {block.kind === "listItem" ? (
              <span className="text-muted-foreground">•</span>
            ) : null}
            {numbers[i] === undefined ? null : (
              <span className="text-muted-foreground tabular-nums">
                {numbers[i]}.
              </span>
            )}
            <div className="min-w-0 flex-1">
              <BlockEditor
                blockId={block.blockId}
                kind={block.kind}
                text={block.text}
                editable={false}
              />
            </div>
          </div>
          <p className="text-muted-foreground mt-0.5 flex items-baseline gap-1.5 text-xs">
            {block.mark ? (
              <span className="text-foreground font-medium">
                {MARK_LABEL[block.mark]}
              </span>
            ) : null}
            <span>{authorText(block.author, names)}</span>
          </p>
        </div>
      ))}
    </div>
  );
};
