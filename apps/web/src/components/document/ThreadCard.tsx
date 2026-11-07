import { api } from '@atelier/backend/api';
import type { Id } from '@atelier/backend/dataModel';
import { useMutation, useQuery } from 'convex/react';
import { CheckIcon, HistoryIcon, ReplyIcon, RotateCcwIcon } from 'lucide-react';
import { useState } from 'react';
import { StreamingMarkdown } from '~/components/markdown/StreamingMarkdown';
import { PageSpinner } from '~/components/page';
import { errorText } from '~/components/room/errors';
import { Button } from '~/components/ui/button';
import { Sheet, SheetDescription, SheetHeader, SheetPopup, SheetTitle } from '~/components/ui/sheet';
import { authorText, mentionText, type DocThread, type Passage, type ThreadComment } from '~/lib/document';
import { formatTime, type Names, type Participant } from '~/lib/room';
import { BlockText } from './BlockText';
import { MentionInput } from './MentionInput';

const COMMENT_PLACEHOLDER = 'Type @ to ask a model';

/** Runs a mutation, keeping its error to show and whether it is in flight. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function Quote({ text }: { text: string }) {
  return (
    <blockquote className="line-clamp-3 border-l-2 border-warning pl-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">
      {text}
    </blockquote>
  );
}

function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="text-xs text-destructive-foreground">
      {error}
    </p>
  ) : null;
}

interface NewCommentProps {
  passage: Passage;
  /** The passage as stored, shown above the box. */
  exact: string;
  models: readonly Participant[];
  onDone: () => void;
}

/** Starts a thread on a passage someone selected. */
export function NewComment({ passage, exact, models, onDone }: NewCommentProps) {
  const create = useMutation(api.threads.create);
  const [draft, setDraft] = useState('');
  const { busy, error, run } = useAction();

  const post = async () => {
    const body = draft.trim();
    if (!body || busy) return;
    const { blockId, start, end } = passage;
    if (await run(() => create({ blockId, start, end, body }))) onDone();
  };

  return (
    <div role="group" aria-label="New comment" className="mt-1.5 space-y-1.5 rounded-lg border bg-card p-2">
      <Quote text={exact} />
      <MentionInput
        label="Comment"
        autoFocus
        value={draft}
        onChange={setDraft}
        models={models}
        onSubmit={() => void post()}
        placeholder={COMMENT_PLACEHOLDER}
      />
      <div className="flex items-center gap-1.5">
        <Button size="xs" disabled={!draft.trim() || busy} onClick={() => void post()}>
          Post comment
        </Button>
        <Button size="xs" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
      <ErrorLine error={error} />
    </div>
  );
}

interface ThreadCardProps {
  thread: DocThread;
  names: Names;
  models: readonly Participant[];
}

/** One thread: its passage, its comments with their authors and mentions, and its actions. */
export function ThreadCard({ thread, names, models }: ThreadCardProps) {
  const threadId = thread._id as Id<'threads'>;
  const settle = useMutation(api.threads.settle);
  const reopen = useMutation(api.threads.reopen);
  const reply = useMutation(api.threads.reply);
  const [replying, setReplying] = useState(false);
  const [draft, setDraft] = useState('');
  const [showOriginal, setShowOriginal] = useState(false);
  const { busy, error, run } = useAction();
  const open = thread.state === 'open';
  const removedBy = thread.detachedBeforeChangeSetId as Id<'changeSets'> | null;

  const postReply = async () => {
    const body = draft.trim();
    if (!body || busy) return;
    if (await run(() => reply({ threadId, body }))) {
      setDraft('');
      setReplying(false);
    }
  };

  return (
    <article aria-label={`Thread on “${thread.exact}”`} className="space-y-2 rounded-lg border bg-card p-2.5 text-sm">
      <Quote text={thread.exact} />
      {removedBy ? (
        <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-warning-foreground">
          <span>Passage removed</span>
          <button
            type="button"
            className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-foreground"
            onClick={() => setShowOriginal(true)}
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
            onSubmit={() => void postReply()}
            placeholder={COMMENT_PLACEHOLDER}
          />
          <div className="flex items-center gap-1.5">
            <Button size="xs" disabled={!draft.trim() || busy} onClick={() => void postReply()}>
              Post reply
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setReplying(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      <div className="flex items-center gap-1">
        {open && !replying ? (
          <Button size="xs" variant="ghost-muted" onClick={() => setReplying(true)}>
            <ReplyIcon />
            Reply
          </Button>
        ) : null}
        {open ? (
          <Button size="xs" variant="ghost-muted" className="ml-auto" disabled={busy} onClick={() => void run(() => settle({ threadId }))}>
            <CheckIcon />
            Settle
          </Button>
        ) : (
          <Button size="xs" variant="ghost-muted" className="ml-auto" disabled={busy} onClick={() => void run(() => reopen({ threadId }))}>
            <RotateCcwIcon />
            Reopen
          </Button>
        )}
      </div>
      <ErrorLine error={error} />
      {removedBy ? (
        <OriginalVersion changeSetId={removedBy} blockId={thread.blockId} names={names} open={showOriginal} onOpenChange={setShowOriginal} />
      ) : null}
    </article>
  );
}

function CommentItem({ comment, names }: { comment: ThreadComment; names: Names }) {
  return (
    <li className="space-y-0.5">
      <div className="flex items-baseline gap-1.5 text-xs">
        <span className="font-medium">{names(comment.authorParticipantId)}</span>
        <span className="text-muted-foreground">{formatTime(comment.at)}</span>
      </div>
      <StreamingMarkdown text={comment.body} />
      {comment.mentions.length > 0 ? (
        <ul aria-label="Mentions" className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
          {comment.mentions.map((mention) => (
            <li key={mention.participantId} className={mention.state === 'failed' ? 'text-destructive-foreground' : undefined}>
              {mentionText(mention.state, names(mention.participantId))}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

interface OriginalVersionProps {
  changeSetId: Id<'changeSets'>;
  blockId: string;
  names: Names;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** The document as it was just before the change that removed a thread's passage, read-only. */
function OriginalVersion({ changeSetId, blockId, names, open, onOpenChange }: OriginalVersionProps) {
  const version = useQuery(api.history.versionBefore, open ? { changeSetId } : 'skip');
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup side="right" className="w-[min(92vw,36rem)] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Original passage</SheetTitle>
          <SheetDescription>The document just before the change that removed this passage. The commented block is marked.</SheetDescription>
        </SheetHeader>
        {version === undefined ? (
          <PageSpinner />
        ) : (
          <div className="space-y-1 px-6 pb-6">
            {version.blocks.map((block) => (
              <div
                key={block.blockId}
                data-commented={block.blockId === blockId ? '' : undefined}
                className={block.blockId === blockId ? 'rounded-lg bg-warning/12 px-2 py-1.5 ring-1 ring-warning/40' : 'px-2 py-1.5'}
              >
                <BlockText kind={block.kind} text={block.text} />
                <p className="mt-0.5 text-xs text-muted-foreground">{authorText(block.author, names)}</p>
              </div>
            ))}
          </div>
        )}
      </SheetPopup>
    </Sheet>
  );
}
