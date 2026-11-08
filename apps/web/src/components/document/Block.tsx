import { api } from "@atelier/backend/api";
import type { Id } from "@atelier/backend/dataModel";
import { useMutation } from "convex/react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  MessageSquareIcon,
  MessageSquarePlusIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";

import { errorText } from "~/components/room/errors";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  BLOCK_KINDS,
  KIND_LABEL,
  authorText,
  openThreadsText,
} from "~/lib/document";
import type { BlockKind, DocBlock, Passage } from "~/lib/document";
import type { Session } from "~/lib/editor/session";
import type { Names, Participant } from "~/lib/room";
import { cn, hasContent, logFailure } from "~/lib/utils";

import { BlockEditor } from "./BlockEditor";
import { NewComment } from "./ThreadCard";

/** Where a new block goes: after a block, at the end of a heading's section, or at the end of the document. */
export type AddPlace =
  | { afterBlockId: Id<"blocks"> }
  | { endOfSectionId: Id<"blocks"> }
  | Record<string, never>;
interface BlockProps {
  roomId: Id<"rooms">;
  block: DocBlock;
  names: Names;
  meId: string | null;
  /** Who holds an unexpired lease on the block, if anyone. */
  holderId: string | null;
  /** A scribe run holds the document: the block can be read and commented on, not changed. */
  locked: boolean;
  isFirst: boolean;
  isLast: boolean;
  /** The person's editing session, and the key it knows this block by. */
  session: Session<Id<"blocks">>;
  sessionKey: Id<"blocks">;
  /** Puts the caret in the block when it first renders. */
  autoFocus: boolean;
  /** A block was added from this block's Add below. */
  onAdded: (blockId: Id<"blocks">) => void;
  /** The room's model participants, offered as mentions. */
  models: readonly Participant[];
  /** Whether the reader has selected text in this block that a comment can anchor to. */
  commentable: boolean;
  onComment: () => void;
  /** The passage of this block a new comment is being written on. */
  commentDraft: Passage | null;
  onCommentDone: () => void;
}

const ToolButton = ({
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
}) => (
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
/** Picks the kind of a new block and adds it at `place`. The new block opens for editing. */
export const AddChoices = ({
  roomId,
  place,
  label,
  onClose,
  onAdded,
  className,
}: {
  roomId: Id<"rooms">;
  place: AddPlace;
  label: string;
  onClose: () => void;
  onAdded: (blockId: Id<"blocks">) => void;
  className?: string;
}) => {
  const add = useMutation(api.blocks.add);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = async (kind: BlockKind) => {
    setBusy(true);
    setError(null);
    try {
      const blockId = await add({ roomId, ...place, kind, text: "" });
      onClose();
      onAdded(blockId);
    } catch (error_) {
      setError(errorText(error_));
    }
    setBusy(false);
  };

  return (
    <fieldset
      aria-label={label}
      className={cn(
        "mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5",
        className
      )}
    >
      {BLOCK_KINDS.map((kind, index) => (
        <Button
          key={kind}
          size="xs"
          variant="outline"
          disabled={busy}
          autoFocus={index === 1}
          onClick={() => {
            choose(kind).catch(logFailure);
          }}
        >
          {KIND_LABEL[kind]}
        </Button>
      ))}
      <Button size="xs" variant="ghost" onClick={onClose}>
        Cancel
      </Button>
      {hasContent(error) ? (
        <p role="alert" className="text-destructive-foreground w-full text-xs">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
};

/** The row of actions on a block. */
const BlockTools = ({
  kind,
  blocked,
  locked,
  adding,
  isFirst,
  isLast,
  onToggleAdd,
  onMove,
  onDelete,
}: {
  kind: BlockKind;
  blocked: boolean;
  locked: boolean;
  adding: boolean;
  isFirst: boolean;
  isLast: boolean;
  onToggleAdd: () => void;
  onMove: (direction: "up" | "down") => void;
  onDelete: () => void;
}) => (
  <div
    role="toolbar"
    aria-label={`${KIND_LABEL[kind]} actions`}
    className="ml-auto flex items-center gap-0.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100"
  >
    <ToolButton
      label="Add below"
      disabled={locked}
      pressed={adding && !locked}
      onClick={onToggleAdd}
    >
      <PlusIcon />
    </ToolButton>
    <ToolButton
      label="Move up"
      disabled={isFirst || blocked}
      onClick={() => {
        onMove("up");
      }}
    >
      <ArrowUpIcon />
    </ToolButton>
    <ToolButton
      label="Move down"
      disabled={isLast || blocked}
      onClick={() => {
        onMove("down");
      }}
    >
      <ArrowDownIcon />
    </ToolButton>
    <ToolButton label="Delete" disabled={blocked} onClick={onDelete}>
      <Trash2Icon />
    </ToolButton>
  </div>
);

// "Robert Guss" -> "RG", "Dana" -> "D".
const initials = (name: string) =>
  name
    .split(/\s+/u)
    .map((word) => word.charAt(0))
    .join("")
    .slice(0, 2)
    .toUpperCase();

/** What a refused write left behind: the reason, and the person's text to copy or set aside. */
const DraftNotice = ({
  draft,
  onDiscard,
}: {
  draft: { text: string; message: string };
  onDiscard: () => void;
}) => {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(draft.text);
    setCopied(true);
  };
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
      <p role="alert" className="text-destructive-foreground mr-auto">
        {draft.message}
      </p>
      <Button
        size="xs"
        variant="outline"
        onClick={() => {
          copy().catch(logFailure);
        }}
      >
        {copied ? "Copied" : "Copy my draft"}
      </Button>
      <Button size="xs" variant="ghost" onClick={onDiscard}>
        Discard my draft
      </Button>
    </div>
  );
};

export const Block = ({
  roomId,
  block,
  names,
  meId,
  holderId,
  locked,
  isFirst,
  isLast,
  session,
  sessionKey,
  autoFocus,
  onAdded,
  models,
  commentable,
  onComment,
  commentDraft,
  onCommentDone,
}: BlockProps) => {
  const blockId = block._id;
  const move = useMutation(api.blocks.move);
  const remove = useMutation(api.blocks.remove);
  const local = useSyncExternalStore(session.subscribe, () =>
    session.local(sessionKey)
  );
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const otherHolder = holderId !== null && holderId !== meId ? holderId : null;
  const blocked = locked || otherHolder !== null;

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
    } catch (error_) {
      setError(errorText(error_));
    }
  };

  return (
    <div
      data-block-id={block._id}
      className="group hover:bg-accent/30 focus-within:bg-accent/30 relative rounded-lg px-2 py-1.5"
    >
      <div
        onFocus={() => {
          session.focus(sessionKey);
        }}
        onBlur={() => {
          session.blur(sessionKey);
        }}
      >
        <BlockEditor
          blockId={blockId}
          kind={block.kind}
          text={local.text ?? block.text}
          editable={!blocked}
          autoFocus={autoFocus}
          onChange={(text) => {
            session.change(sessionKey, text, block.rev);
          }}
        />
      </div>
      {local.draft ? (
        <DraftNotice
          draft={local.draft}
          onDiscard={() => {
            session.discard(sessionKey);
          }}
        />
      ) : null}
      <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="text-foreground/80 font-medium">
          {authorText(block.author, names)}
        </span>
        {/* Present before anyone holds the block, so a new holder is announced. */}
        <span aria-live="polite" className="contents">
          {otherHolder === null ? null : (
            <Badge variant="warning">
              <span
                aria-hidden
                className="bg-background/60 inline-flex size-4 items-center justify-center rounded-full text-[0.6rem] font-semibold"
              >
                {initials(names(otherHolder))}
              </span>
              {names(otherHolder)} is editing
            </Badge>
          )}
        </span>
        {block.openThreads > 0 ? (
          <Badge variant="outline">
            <MessageSquareIcon />
            {openThreadsText(block.openThreads)}
          </Badge>
        ) : null}
        {commentable ? (
          <Button
            size="xs"
            variant="outline"
            // Keeps the selection while the button is pressed.
            onMouseDown={(e) => {
              e.preventDefault();
            }}
            onClick={onComment}
          >
            <MessageSquarePlusIcon />
            Comment
          </Button>
        ) : null}
        <BlockTools
          kind={block.kind}
          blocked={blocked}
          locked={locked}
          adding={adding}
          isFirst={isFirst}
          isLast={isLast}
          onToggleAdd={() => {
            setAdding((a) => !a);
          }}
          onMove={(direction) => {
            run(async () => await move({ blockId, direction })).catch(
              logFailure
            );
          }}
          onDelete={() => {
            setConfirmingDelete(true);
          }}
        />
      </div>
      {hasContent(error) ? (
        <p role="alert" className="text-destructive-foreground mt-1 text-xs">
          {error}
        </p>
      ) : null}
      {confirmingDelete && !locked ? (
        <fieldset
          aria-label="Confirm deletion"
          className="mt-1.5 flex min-w-0 flex-wrap items-center gap-2 text-sm"
        >
          <span className="mr-auto">
            Delete this block? History keeps a copy.
          </span>
          <Button
            size="xs"
            variant="destructive"
            autoFocus
            onClick={() => {
              setConfirmingDelete(false);
              run(async () => await remove({ blockId })).catch(logFailure);
            }}
          >
            Delete this block
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              setConfirmingDelete(false);
            }}
          >
            Keep it
          </Button>
        </fieldset>
      ) : null}
      {commentDraft ? (
        <NewComment
          passage={commentDraft}
          exact={block.text.slice(commentDraft.start, commentDraft.end)}
          models={models}
          onDone={onCommentDone}
        />
      ) : null}
      {adding && !locked ? (
        <AddChoices
          roomId={roomId}
          place={{ afterBlockId: blockId }}
          label="Add below this block"
          onClose={() => {
            setAdding(false);
          }}
          onAdded={onAdded}
        />
      ) : null}
    </div>
  );
};
