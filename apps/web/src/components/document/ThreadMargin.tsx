import { threadsInBlockOrder, type DocBlock, type ThreadsData } from '~/lib/document';
import type { Names, Participant } from '~/lib/room';
import { cn } from '~/lib/utils';
import { SettledSection } from './SettledSection';
import { ThreadCard } from './ThreadCard';

interface ThreadMarginProps {
  threads: ThreadsData;
  blocks: readonly DocBlock[];
  names: Names;
  models: readonly Participant[];
  className?: string;
}

/** The comment threads beside the document: open ones in block order, then the folded Settled section. */
export function ThreadMargin({ threads, blocks, names, models, className }: ThreadMarginProps) {
  const open = threadsInBlockOrder(threads.open, blocks);
  const settled = threadsInBlockOrder(threads.settled, blocks);
  return (
    <aside aria-label="Comments" className={cn('space-y-3', className)}>
      {open.length === 0 ? <p className="text-xs text-muted-foreground">Select text in the document to comment on it.</p> : null}
      {open.map((thread) => (
        <ThreadCard key={thread._id} thread={thread} names={names} models={models} />
      ))}
      {settled.length > 0 ? <SettledSection threads={settled} names={names} models={models} /> : null}
    </aside>
  );
}
