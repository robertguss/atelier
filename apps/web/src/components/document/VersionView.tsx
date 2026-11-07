import { authorText, MARK_LABEL, type BlockMark, type VersionBlock } from '~/lib/document';
import type { Names } from '~/lib/room';
import { cn } from '~/lib/utils';
import { BlockText } from './BlockText';

const MARK_STYLE: Record<BlockMark, string> = {
  added: 'bg-success/10 ring-success/40',
  changed: 'bg-info/10 ring-info/40',
  moved: 'bg-info/6 ring-info/30',
  removed: 'bg-destructive/8 ring-destructive/30 [&_[data-block-body]]:line-through [&_[data-block-body]]:opacity-70',
  commented: 'bg-warning/12 ring-warning/40',
};

export type MarkedBlock = VersionBlock & { mark: BlockMark | null };

/** An earlier version of the document, read-only, with any marked blocks set apart. */
export function VersionView({ blocks, names }: { blocks: readonly MarkedBlock[]; names: Names }) {
  if (blocks.length === 0) return <p className="px-2 py-1.5 text-sm text-muted-foreground">The document was empty.</p>;
  return (
    <div className="space-y-1">
      {blocks.map((block) => (
        <div
          key={block.blockId}
          data-version-block=""
          data-mark={block.mark ?? undefined}
          className={cn('px-2 py-1.5', block.mark && cn('rounded-lg ring-1', MARK_STYLE[block.mark]))}
        >
          <div data-block-body="">
            <BlockText kind={block.kind} text={block.text} />
          </div>
          <p className="mt-0.5 flex items-baseline gap-1.5 text-xs text-muted-foreground">
            {block.mark ? <span className="font-medium text-foreground">{MARK_LABEL[block.mark]}</span> : null}
            <span>{authorText(block.author, names)}</span>
          </p>
        </div>
      ))}
    </div>
  );
}
