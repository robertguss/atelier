import { api } from '@atelier/backend/api';
import type { Id } from '@atelier/backend/dataModel';
import { useMutation } from 'convex/react';
import { ArrowDownIcon, ArrowUpIcon, MessageSquareIcon, MessageSquarePlusIcon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { errorText } from '~/components/room/errors';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { BLOCK_KINDS, KIND_LABEL, authorText, openThreadsText, type BlockKind, type DocBlock, type Passage } from '~/lib/document';
import type { Names, Participant } from '~/lib/room';
import { cn } from '~/lib/utils';
import { BlockEditor } from './BlockEditor';
import { BlockText } from './BlockText';
import { NewComment } from './ThreadCard';

/** Where a new block goes: after a block, at the end of a heading's section, or at the end of the document. */
export type AddPlace = { afterBlockId: Id<'blocks'> } | { endOfSectionId: Id<'blocks'> } | Record<string, never>;

interface BlockProps {
  roomId: Id<'rooms'>;
  block: DocBlock;
  names: Names;
  meId: string | null;
  /** Who holds an unexpired lease on the block, if anyone. */
  holderId: string | null;
  /** A scribe run holds the document: the block can be read and commented on, not changed. */
  locked: boolean;
  isFirst: boolean;
  isLast: boolean;
  editing: boolean;
  onEditing: (blockId: Id<'blocks'>) => void;
  onDoneEditing: (blockId: Id<'blocks'>) => void;
  /** The room's model participants, offered as mentions. */
  models: readonly Participant[];
  /** Whether the reader has selected text in this block that a comment can anchor to. */
  commentable: boolean;
  onComment: () => void;
  /** The passage of this block a new comment is being written on. */
  commentDraft: Passage | null;
  onCommentDone: () => void;
}

export function Block({
  roomId,
  block,
  names,
  meId,
  holderId,
  locked,
  isFirst,
  isLast,
  editing,
  onEditing,
  onDoneEditing,
  models,
  commentable,
  onComment,
  commentDraft,
  onCommentDone,
}: BlockProps) {
  const blockId = block._id as Id<'blocks'>;
  const startEdit = useMutation(api.blocks.startEdit);
  const move = useMutation(api.blocks.move);
  const remove = useMutation(api.blocks.remove);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const otherHolder = holderId && holderId !== meId ? holderId : null;
  const blocked = locked || !!otherHolder;

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const edit = () =>
    run(async () => {
      await startEdit({ blockId });
      onEditing(blockId);
    });

  return (
    <div data-block-id={block._id} className="group relative rounded-lg px-2 py-1.5 hover:bg-accent/30 focus-within:bg-accent/30">
      {editing ? (
        <BlockEditor block={block} otherHolder={otherHolder} onDone={() => onDoneEditing(blockId)} />
      ) : (
        // Comments start from a selection here; the document maps it to the stored text.
        <div data-block-text={block.text.trim() ? block._id : undefined}>
          <BlockText kind={block.kind} text={block.text} />
        </div>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground/80">{authorText(block.author, names)}</span>
        {otherHolder ? <Badge variant="warning">{names(otherHolder)} is editing</Badge> : null}
        {block.openThreads > 0 ? (
          <Badge variant="outline">
            <MessageSquareIcon />
            {openThreadsText(block.openThreads)}
          </Badge>
        ) : null}
        {commentable && !editing ? (
          <Button
            size="xs"
            variant="outline"
            // Keeps the selection while the button is pressed.
            onMouseDown={(e) => e.preventDefault()}
            onClick={onComment}
          >
            <MessageSquarePlusIcon />
            Comment
          </Button>
        ) : null}
        <div
          role="toolbar"
          aria-label={`${KIND_LABEL[block.kind]} actions`}
          className="ml-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100"
        >
          <ToolButton label="Edit" disabled={editing || blocked} onClick={() => void edit()}>
            <PencilIcon />
          </ToolButton>
          <ToolButton label="Add below" disabled={locked} pressed={adding && !locked} onClick={() => setAdding((a) => !a)}>
            <PlusIcon />
          </ToolButton>
          <ToolButton label="Move up" disabled={isFirst || blocked} onClick={() => void run(() => move({ blockId, direction: 'up' }))}>
            <ArrowUpIcon />
          </ToolButton>
          <ToolButton label="Move down" disabled={isLast || blocked} onClick={() => void run(() => move({ blockId, direction: 'down' }))}>
            <ArrowDownIcon />
          </ToolButton>
          <ToolButton label="Delete" disabled={editing || blocked} onClick={() => setConfirmingDelete(true)}>
            <Trash2Icon />
          </ToolButton>
        </div>
      </div>
      {error ? (
        <p role="alert" className="mt-1 text-xs text-destructive-foreground">
          {error}
        </p>
      ) : null}
      {confirmingDelete && !locked ? (
        <div role="group" aria-label="Confirm deletion" className="mt-1.5 flex flex-wrap items-center gap-2 text-sm">
          <span className="mr-auto">Delete this block? History keeps a copy.</span>
          <Button
            size="xs"
            variant="destructive"
            autoFocus
            onClick={() => {
              setConfirmingDelete(false);
              void run(() => remove({ blockId }));
            }}
          >
            Delete this block
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setConfirmingDelete(false)}>
            Keep it
          </Button>
        </div>
      ) : null}
      {commentDraft && !editing ? (
        <NewComment passage={commentDraft} exact={block.text.slice(commentDraft.start, commentDraft.end)} models={models} onDone={onCommentDone} />
      ) : null}
      {adding && !locked ? (
        <AddChoices
          roomId={roomId}
          place={{ afterBlockId: blockId }}
          label="Add below this block"
          onClose={() => setAdding(false)}
          onAdded={onEditing}
        />
      ) : null}
    </div>
  );
}

function ToolButton({
  label,
  disabled,
  pressed,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      size="icon-xs"
      variant="ghost-muted"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

/** Picks the kind of a new block and adds it at `place`. The new block opens for editing. */
export function AddChoices({
  roomId,
  place,
  label,
  onClose,
  onAdded,
  className,
}: {
  roomId: Id<'rooms'>;
  place: AddPlace;
  label: string;
  onClose: () => void;
  onAdded: (blockId: Id<'blocks'>) => void;
  className?: string;
}) {
  const add = useMutation(api.blocks.add);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = async (kind: BlockKind) => {
    setBusy(true);
    setError(null);
    try {
      const blockId = await add({ roomId, ...place, kind, text: '' });
      onClose();
      onAdded(blockId);
    } catch (e) {
      setError(errorText(e));
    }
    setBusy(false);
  };

  return (
    <div role="group" aria-label={label} className={cn('mt-1.5 flex flex-wrap items-center gap-1.5', className)}>
      {BLOCK_KINDS.map((kind, index) => (
        <Button key={kind} size="xs" variant="outline" disabled={busy} autoFocus={index === 1} onClick={() => void choose(kind)}>
          {KIND_LABEL[kind]}
        </Button>
      ))}
      <Button size="xs" variant="ghost" onClick={onClose}>
        Cancel
      </Button>
      {error ? (
        <p role="alert" className="w-full text-xs text-destructive-foreground">
          {error}
        </p>
      ) : null}
    </div>
  );
}
