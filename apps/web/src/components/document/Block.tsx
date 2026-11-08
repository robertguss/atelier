import { api } from "@atelier/backend/api";
import type { Id } from "@atelier/backend/dataModel";
import { useMutation } from "convex/react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  MessageSquareIcon,
  MessageSquarePlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { errorText } from "~/components/room/errors";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { KIND_LABEL, authorText, openThreadsText } from "~/lib/document";
import type { BlockKind, DocBlock, Passage } from "~/lib/document";
import { intentFor } from "~/lib/editor/keymap";
import type { KeyContext } from "~/lib/editor/keymap";
import type { Session } from "~/lib/editor/session";
import type { Names, Participant } from "~/lib/room";
import { hasContent, logFailure } from "~/lib/utils";

import { BlockEditor, KindMarker } from "./BlockEditor";
import type { Caret } from "./BlockEditor";
import { NewComment } from "./ThreadCard";
import { useBlockActions } from "./useBlockActions";

/** A request to put the caret in a block; each is a new object. */
export interface CaretRequest {
  key: Id<"blocks">;
  at: Caret;
}

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
  /** The blocks around this one as shown, and whoever else is editing the one above. */
  previous: DocBlock | null;
  next: DocBlock | null;
  previousHeldBy: string | null;
  /** The block's place in its run of numbered items. */
  number: number | undefined;
  /** The person's editing session, and the key it knows this block by. */
  session: Session<Id<"blocks">>;
  sessionKey: Id<"blocks">;
  /** A request to put the caret in this block. */
  caret: CaretRequest | undefined;
  onCaret: (key: Id<"blocks">, at: Caret) => void;
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
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) => (
  <Button
    size="icon-xs"
    variant="ghost-muted"
    aria-label={label}
    title={label}
    disabled={disabled}
    onClick={onClick}
  >
    {children}
  </Button>
);
/** The row of actions on a block. */
const BlockTools = ({
  kind,
  blocked,
  isFirst,
  isLast,
  onMove,
  onDelete,
}: {
  kind: BlockKind;
  blocked: boolean;
  isFirst: boolean;
  isLast: boolean;
  onMove: (direction: "up" | "down") => void;
  onDelete: () => void;
}) => (
  <div
    role="toolbar"
    aria-label={`${KIND_LABEL[kind]} actions`}
    className="ml-auto flex items-center gap-0.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100"
  >
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

const DIVIDER_KEYS: readonly KeyContext["key"][] = [
  "Enter",
  "Shift-Enter",
  "Backspace",
  "Delete",
  "ArrowUp",
  "ArrowDown",
];

/** A divider the person can reach with the keyboard: Enter adds a paragraph below it, Backspace or Delete removes it. */
const FocusableDivider = ({
  caret,
  onKey,
}: {
  caret: CaretRequest | undefined;
  onKey: (key: KeyContext["key"]) => boolean;
}) => {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (caret) {
      ref.current?.focus();
    }
  }, [caret]);
  const onKeyDown = (e: KeyboardEvent) => {
    const name = e.key === "Enter" && e.shiftKey ? "Shift-Enter" : e.key;
    const key = DIVIDER_KEYS.find((k) => k === name);
    if (key !== undefined && onKey(key)) {
      e.preventDefault();
    }
  };
  return (
    <button
      ref={ref}
      type="button"
      data-kind="divider"
      aria-label="Divider"
      onKeyDown={onKeyDown}
      className="focus-visible:ring-ring block w-full rounded-sm py-3 outline-none focus-visible:ring-2"
    >
      <span className="border-border block border-t" />
    </button>
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
  previous,
  next,
  previousHeldBy,
  number,
  session,
  sessionKey,
  caret,
  onCaret,
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
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const otherHolder = holderId !== null && holderId !== meId ? holderId : null;
  const blocked = locked || otherHolder !== null;
  // The block as the person sees it, before their writes land.
  const shown: DocBlock = {
    ...block,
    checked: local.checked ?? block.checked,
    kind: local.kind ?? block.kind,
    text: local.text ?? block.text,
  };
  const actions = useBlockActions({
    block: shown,
    next,
    onCaret,
    onError: setError,
    previous,
    previousHeldBy,
    roomId,
    session,
    sessionKey,
  });

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
        className="flex items-baseline gap-2"
        onFocus={() => {
          session.focus(sessionKey);
        }}
        onBlur={() => {
          session.blur(sessionKey);
        }}
      >
        <KindMarker
          kind={shown.kind}
          checked={shown.checked ?? false}
          number={number}
          label={shown.text}
          onToggle={blocked ? undefined : actions.handleToggle}
        />
        <div className="min-w-0 flex-1">
          {shown.kind === "divider" && !blocked ? (
            <FocusableDivider
              caret={caret}
              onKey={(key) => {
                const { intent } = intentFor({
                  ...actions.keys.neighbours(),
                  atEnd: true,
                  atStart: true,
                  empty: true,
                  firstLine: true,
                  key,
                  kind: "divider",
                  lastLine: true,
                });
                actions.intent(intent, null);
                return intent !== "none";
              }}
            />
          ) : (
            <BlockEditor
              blockId={blockId}
              kind={shown.kind}
              text={shown.text}
              editable={!blocked}
              caret={caret}
              onChange={actions.handleChange}
              onKind={actions.handleKind}
              onDivider={actions.handleDivider}
              keys={actions.keys}
            />
          )}
        </div>
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
          isFirst={isFirst}
          isLast={isLast}
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
    </div>
  );
};
