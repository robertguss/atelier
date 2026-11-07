import { api } from '@atelier/backend/api';
import type { Id } from '@atelier/backend/dataModel';
import { useMutation, useQuery } from 'convex/react';
import { FileTextIcon, PlusIcon } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { PageSpinner } from '~/components/page';
import { errorText } from '~/components/room/errors';
import { Button } from '~/components/ui/button';
import { leaseHolder, sectionsOf, type DocBlock, type Passage, type Section, type ThreadsData } from '~/lib/document';
import { useNow, type Names, type Participant } from '~/lib/room';
import { renderedRange, selectionIn, sourceRange } from '~/lib/selection';
import { AddChoices, Block, type AddPlace } from './Block';
import { ThreadMargin } from './ThreadMargin';

interface DocumentPaneProps {
  roomId: Id<'rooms'>;
  names: Names;
  /** The person's own participant in this room. */
  meId: string | null;
  /** The room's model participants, offered as mentions in comments. */
  models: readonly Participant[];
}

/** The room's shared document, edited one block at a time. */
export function DocumentPane({ roomId, names, meId, models }: DocumentPaneProps) {
  const doc = useQuery(api.documents.get, { roomId });
  const threads = useQuery(api.threads.list, { roomId });
  const ensure = useMutation(api.documents.ensure);
  const [ensureError, setEnsureError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<Id<'blocks'> | null>(null);
  // Leases lapse on the clock; re-check who holds a block now and then.
  const now = useNow(10_000);
  const blocks = doc?.blocks;
  const selected = useBlockSelection(blocks);
  const [commentDraft, setCommentDraft] = useState<Passage | null>(null);
  const textRef = useRef<HTMLDivElement>(null);
  useCommentHighlights(textRef, blocks, threads, commentDraft);

  // Rooms made before documents existed get theirs seeded on first open.
  const ensuredFor = useRef<string | null>(null);
  useEffect(() => {
    if (ensuredFor.current === roomId) return;
    ensuredFor.current = roomId;
    ensure({ roomId }).catch((e: unknown) => setEnsureError(errorText(e)));
  }, [ensure, roomId]);

  const doneEditing = (blockId: Id<'blocks'>) => setEditingId((current) => (current === blockId ? null : current));

  let body;
  if (doc === undefined || (doc === null && !ensureError)) {
    body = <PageSpinner />;
  } else if (doc === null) {
    body = (
      <p role="alert" className="py-6 text-center text-sm text-destructive-foreground">
        {ensureError}
      </p>
    );
  } else {
    const blocks = doc.blocks;
    const sections = sectionsOf(blocks);
    const onlyLoose = sections.every((s) => s.heading === null);
    body = (
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-5 @4xl:flex-row @4xl:items-start">
        <div ref={textRef} className="w-full min-w-0 max-w-3xl flex-1 space-y-4">
          {sections.map((section, index) => (
            <div key={section.heading?._id ?? `loose-${index}`} className="space-y-0.5">
              {sectionBlocks(section).map((block) => (
                <Block
                  key={block._id}
                  roomId={roomId}
                  block={block}
                  names={names}
                  meId={meId}
                  holderId={leaseHolder(block, now)}
                  isFirst={block._id === blocks[0]?._id}
                  isLast={block._id === blocks[blocks.length - 1]?._id}
                  editing={editingId === block._id}
                  onEditing={setEditingId}
                  onDoneEditing={doneEditing}
                  models={models}
                  commentable={selected?.blockId === block._id}
                  onComment={() => setCommentDraft(selected)}
                  commentDraft={commentDraft?.blockId === block._id ? commentDraft : null}
                  onCommentDone={() => setCommentDraft(null)}
                />
              ))}
              {section.heading ? (
                <SectionAdd
                  roomId={roomId}
                  label={`Add to ${section.heading.text || 'this section'}`}
                  place={{ endOfSectionId: section.heading._id as Id<'blocks'> }}
                  onAdded={setEditingId}
                />
              ) : null}
            </div>
          ))}
          {onlyLoose ? <SectionAdd roomId={roomId} label="Add to the document" place={{}} onAdded={setEditingId} /> : null}
        </div>
        {threads ? (
          <ThreadMargin threads={threads} blocks={blocks} names={names} models={models} className="w-full @4xl:w-72 @4xl:shrink-0" />
        ) : null}
      </div>
    );
  }

  return (
    <section aria-label="Room document" className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b px-4 py-2.5">
        <FileTextIcon className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Document</h2>
        <span className="text-xs text-muted-foreground">Shared with everyone in the room, agents included.</span>
      </header>
      <div className="@container min-h-0 flex-1 overflow-y-auto">{body}</div>
    </section>
  );
}

/** The passage of a read-view block the reader has selected, as offsets in its stored text. */
function useBlockSelection(blocks: readonly DocBlock[] | undefined): Passage | null {
  const [selected, setSelected] = useState<Passage | null>(null);
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  useEffect(() => {
    const onChange = () => {
      const selection = document.getSelection();
      const anchor = selection?.anchorNode;
      const element = (anchor instanceof Element ? anchor : anchor?.parentElement)?.closest<HTMLElement>('[data-block-text]');
      const block = element && blocksRef.current?.find((b) => b._id === element.dataset.blockText);
      const read = element && selectionIn(element, selection ?? null);
      const range = block && read ? sourceRange(block.text, read.selected, read.before) : null;
      const next = block && range ? { blockId: block._id as Id<'blocks'>, ...range } : null;
      setSelected((current) =>
        current?.blockId === next?.blockId && current?.start === next?.start && current?.end === next?.end ? current : next,
      );
    };
    document.addEventListener('selectionchange', onChange);
    return () => document.removeEventListener('selectionchange', onChange);
  }, []);
  return selected;
}

// Names of the CSS highlights that mark commented passages and the one a
// new comment is being written on; index.css styles them.
const COMMENT_HIGHLIGHT = 'atelier-comment';
const DRAFT_HIGHLIGHT = 'atelier-comment-draft';

/**
 * Marks the passages of open threads, and of the comment being written,
 * with the CSS Custom Highlight API, so the rendered text is left as it is.
 * Browsers without the API show no marks.
 */
function useCommentHighlights(
  rootRef: RefObject<HTMLElement | null>,
  blocks: readonly DocBlock[] | undefined,
  threads: ThreadsData | undefined,
  draft: Passage | null,
) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') return;
    const registry = CSS.highlights;
    const byId = new Map<string, DocBlock>((blocks ?? []).map((b) => [b._id, b]));
    const rangeOf = (blockId: string, start: number, end: number) => {
      const block = byId.get(blockId);
      const element = root.querySelector(`[data-block-text="${blockId}"]`);
      return block && element ? renderedRange(element, block.text, start, end) : null;
    };
    const marked = (threads?.open ?? [])
      .filter((t) => !t.detachedBeforeChangeSetId)
      .map((t) => rangeOf(t.blockId, t.position, t.position + t.exact.length))
      .filter((r): r is Range => r !== null);
    registry.set(COMMENT_HIGHLIGHT, new Highlight(...marked));
    const drafting = draft && rangeOf(draft.blockId, draft.start, draft.end);
    if (drafting) registry.set(DRAFT_HIGHLIGHT, new Highlight(drafting));
    return () => {
      registry.delete(COMMENT_HIGHLIGHT);
      registry.delete(DRAFT_HIGHLIGHT);
    };
  });
}

function sectionBlocks(section: Section) {
  return section.heading ? [section.heading, ...section.blocks] : section.blocks;
}

function SectionAdd({
  roomId,
  label,
  place,
  onAdded,
}: {
  roomId: Id<'rooms'>;
  label: string;
  place: AddPlace;
  onAdded: (blockId: Id<'blocks'>) => void;
}) {
  const [open, setOpen] = useState(false);
  if (open) return <AddChoices roomId={roomId} place={place} label={label} onClose={() => setOpen(false)} onAdded={onAdded} className="px-2" />;
  return (
    <Button size="xs" variant="ghost-muted" className="ml-1" onClick={() => setOpen(true)}>
      <PlusIcon />
      {label}
    </Button>
  );
}
