import { api } from "@atelier/backend/api";
import type { Id } from "@atelier/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import { CheckIcon, HistoryIcon, ReplyIcon, RotateCcwIcon } from "lucide-react";
import { useState } from "react";

import { StreamingMarkdown } from "~/components/markdown/StreamingMarkdown";
import { PageSpinner } from "~/components/page";
import { errorText } from "~/components/room/errors";
import { Button } from "~/components/ui/button";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "~/components/ui/sheet";
import { mentionText } from "~/lib/document";
import type { DocThread, Passage, ThreadComment } from "~/lib/document";
import { formatTime } from "~/lib/room";
import type { Names, Participant } from "~/lib/room";
import { hasContent, logFailure } from "~/lib/utils";

import { MentionInput } from "./MentionInput";
import { VersionView } from "./VersionView";

const COMMENT_PLACEHOLDER = "Type @ to ask a model";

/** Runs a mutation, keeping its error to show and whether it is in flight. */
const useAction = () => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    let ok = true;
    try {
      await action();
    } catch (error_) {
      setError(errorText(error_));
      ok = false;
    }
    setBusy(false);
    return ok;
  };
  return { busy, error, run };
};

const Quote = ({ text }: { text: string }) => (
  <blockquote className="border-warning text-muted-foreground line-clamp-3 border-l-2 pl-2 text-xs [overflow-wrap:anywhere]">
    {text}
  </blockquote>
);
const ErrorLine = ({ error }: { error: string | null }) =>
  hasContent(error) ? (
    <p role="alert" className="text-destructive-foreground text-xs">
      {error}
    </p>
  ) : null;
interface NewCommentProps {
  passage: Passage;
  /** The passage as stored, shown above the box. */
  exact: string;
  models: readonly Participant[];
  onDone: () => void;
}

/** Starts a thread on a passage someone selected. */
export const NewComment = ({
  passage,
  exact,
  models,
  onDone,
}: NewCommentProps) => {
  const create = useMutation(api.threads.create);
  const [draft, setDraft] = useState("");
  const { busy, error, run } = useAction();

  const post = async () => {
    const body = draft.trim();
    if (!body || busy) {
      return;
    }
    const { blockId, start, end } = passage;
    if (await run(async () => await create({ blockId, body, end, start }))) {
      onDone();
    }
  };

  return (
    <fieldset
      aria-label="New comment"
      className="bg-card mt-1.5 min-w-0 space-y-1.5 rounded-lg border p-2"
    >
      <Quote text={exact} />
      <MentionInput
        label="Comment"
        autoFocus
        value={draft}
        onChange={setDraft}
        models={models}
        onSubmit={() => {
          post().catch(logFailure);
        }}
        placeholder={COMMENT_PLACEHOLDER}
      />
      <div className="flex items-center gap-1.5">
        <Button
          size="xs"
          disabled={!draft.trim() || busy}
          onClick={() => {
            post().catch(logFailure);
          }}
        >
          Post comment
        </Button>
        <Button size="xs" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
      <ErrorLine error={error} />
    </fieldset>
  );
};

interface ThreadCardProps {
  thread: DocThread;
  names: Names;
  models: readonly Participant[];
}

const CommentItem = ({
  comment,
  names,
}: {
  comment: ThreadComment;
  names: Names;
}) => (
  <li className="space-y-0.5">
    <div className="flex items-baseline gap-1.5 text-xs">
      <span className="font-medium">{names(comment.authorParticipantId)}</span>
      <span className="text-muted-foreground">{formatTime(comment.at)}</span>
    </div>
    <StreamingMarkdown text={comment.body} />
    {comment.mentions.length > 0 ? (
      <ul
        aria-label="Mentions"
        className="text-muted-foreground flex flex-wrap gap-x-2 text-xs"
      >
        {comment.mentions.map((mention) => (
          <li
            key={mention.participantId}
            className={
              mention.state === "failed"
                ? "text-destructive-foreground"
                : undefined
            }
          >
            {mentionText(mention.state, names(mention.participantId))}
          </li>
        ))}
      </ul>
    ) : null}
  </li>
);
/** The document as it was just before the change that removed a thread's passage, read-only. */
const OriginalVersion = ({
  changeSetId,
  blockId,
  names,
  open,
  onOpenChange,
}: OriginalVersionProps) => {
  const version = useQuery(
    api.history.versionBefore,
    open ? { changeSetId } : "skip"
  );
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup side="right" className="w-[min(92vw,36rem)] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Original passage</SheetTitle>
          <SheetDescription>
            The document just before the change that removed this passage. The
            commented block is marked.
          </SheetDescription>
        </SheetHeader>
        {version === undefined ? (
          <PageSpinner />
        ) : (
          <div className="px-6 pb-6">
            <VersionView
              blocks={version.blocks.map((b) => ({
                ...b,
                mark: b.blockId === blockId ? "commented" : null,
              }))}
              names={names}
            />
          </div>
        )}
      </SheetPopup>
    </Sheet>
  );
};

/** One thread: its passage, its comments with their authors and mentions, and its actions. */
export const ThreadCard = ({ thread, names, models }: ThreadCardProps) => {
  const threadId = thread._id;
  const settle = useMutation(api.threads.settle);
  const reopen = useMutation(api.threads.reopen);
  const reply = useMutation(api.threads.reply);
  const [replying, setReplying] = useState(false);
  const [draft, setDraft] = useState("");
  const [showOriginal, setShowOriginal] = useState(false);
  const { busy, error, run } = useAction();
  const open = thread.state === "open";
  const removedBy = thread.detachedBeforeChangeSetId;

  const postReply = async () => {
    const body = draft.trim();
    if (!body || busy) {
      return;
    }
    if (await run(async () => await reply({ body, threadId }))) {
      setDraft("");
      setReplying(false);
    }
  };

  return (
    <article
      aria-label={`Thread on “${thread.exact}”`}
      className="bg-card space-y-2 rounded-lg border p-2.5 text-sm"
    >
      <Quote text={thread.exact} />
      {removedBy ? (
        <p className="text-warning-foreground flex flex-wrap items-center gap-x-1.5 text-xs">
          <span>Passage removed</span>
          <button
            type="button"
            className="hover:text-foreground inline-flex items-center gap-1 underline underline-offset-2"
            onClick={() => {
              setShowOriginal(true);
            }}
          >
            <HistoryIcon className="size-3" />
            View original
          </button>
        </p>
      ) : null}
      <ol className="space-y-2">
        {thread.comments.map((comment) => (
          <CommentItem key={comment._id} comment={comment} names={names} />
        ))}
      </ol>
      {replying ? (
        <div className="space-y-1.5">
          <MentionInput
            label="Reply"
            autoFocus
            value={draft}
            onChange={setDraft}
            models={models}
            onSubmit={() => {
              postReply().catch(logFailure);
            }}
            placeholder={COMMENT_PLACEHOLDER}
          />
          <div className="flex items-center gap-1.5">
            <Button
              size="xs"
              disabled={!draft.trim() || busy}
              onClick={() => {
                postReply().catch(logFailure);
              }}
            >
              Post reply
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                setReplying(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      <div className="flex items-center gap-1">
        {open && !replying ? (
          <Button
            size="xs"
            variant="ghost-muted"
            onClick={() => {
              setReplying(true);
            }}
          >
            <ReplyIcon />
            Reply
          </Button>
        ) : null}
        {open ? (
          <Button
            size="xs"
            variant="ghost-muted"
            className="ml-auto"
            disabled={busy}
            onClick={() => {
              run(async () => await settle({ threadId })).catch(logFailure);
            }}
          >
            <CheckIcon />
            Settle
          </Button>
        ) : (
          <Button
            size="xs"
            variant="ghost-muted"
            className="ml-auto"
            disabled={busy}
            onClick={() => {
              run(async () => await reopen({ threadId })).catch(logFailure);
            }}
          >
            <RotateCcwIcon />
            Reopen
          </Button>
        )}
      </div>
      <ErrorLine error={error} />
      {removedBy ? (
        <OriginalVersion
          changeSetId={removedBy}
          blockId={thread.blockId}
          names={names}
          open={showOriginal}
          onOpenChange={setShowOriginal}
        />
      ) : null}
    </article>
  );
};

interface OriginalVersionProps {
  changeSetId: Id<"changeSets">;
  blockId: string;
  names: Names;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}
