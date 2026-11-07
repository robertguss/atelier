import { api } from '@atelier/backend/api';
import type { Id } from '@atelier/backend/dataModel';
import { useMutation } from 'convex/react';
import { SparklesIcon, SquareIcon, XIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { errorText } from '~/components/room/errors';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { elapsedText, type ScribeRun } from '~/lib/document';
import { useNow, type Names, type Participant } from '~/lib/room';

interface ScribeControlProps {
  roomId: Id<'rooms'>;
  /** The room's model participants; one of them acts as scribe. */
  models: readonly Participant[];
  /** A run already holds the document. */
  locked: boolean;
}

/** The document header's "Call in the scribe" button and the choice of model it opens. */
export function ScribeControl({ roomId, models, locked }: ScribeControlProps) {
  const begin = useMutation(api.scribe.begin);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setOpen(false);
    setError(null);
  };

  const start = async (participantId: Id<'participants'>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await begin({ roomId, participantId });
      setOpen(false);
    } catch (e) {
      setError(errorText(e));
    }
    setBusy(false);
  };

  return (
    <div className="relative">
      <Button size="xs" variant="ghost-muted" disabled={locked || models.length === 0} aria-expanded={open} onClick={() => (open ? close() : setOpen(true))}>
        <SparklesIcon />
        Call in the scribe
      </Button>
      {open && !locked ? (
        <div
          role="group"
          aria-label="Choose the scribe"
          className="absolute right-0 top-full z-20 mt-1 w-72 space-y-2 rounded-lg border bg-popover p-3 text-sm text-popover-foreground shadow-lg"
        >
          <p className="text-xs text-muted-foreground">
            The scribe reorganizes the whole document in one go. The document is saved as a version first, and stays read-only until the scribe
            finishes. Which model should do it?
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            {models.map((model) => (
              <Button key={model._id} size="xs" variant="outline" disabled={busy} onClick={() => void start(model._id as Id<'participants'>)}>
                {model.displayName}
              </Button>
            ))}
            <Button size="xs" variant="ghost" onClick={close}>
              Cancel
            </Button>
          </div>
          {error ? (
            <p role="alert" className="text-xs text-destructive-foreground">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Shown across the document while a run holds it: who is working, for how long, and Stop. */
export function ScribeBanner({ run, names }: { run: ScribeRun | null | undefined; names: Names }) {
  const cancel = useMutation(api.messages.cancel);
  const now = useNow(1_000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const turnId = run?.turnId;

  const stop = async () => {
    if (!turnId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await cancel({ turnId });
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    // A region, not a live status: the elapsed time would be announced every second.
    <section aria-label="The scribe is working" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-accent/40 px-4 py-2 text-sm">
      <Spinner size="sm" tone="muted" role="presentation" aria-hidden />
      <span className="font-medium">The scribe is working</span>
      {run ? (
        <span className="text-xs text-muted-foreground">
          {names(run.participantId)}, started by {names(run.startedByParticipantId)} · {elapsedText(now - run.startedAt)}
        </span>
      ) : null}
      <span className="text-xs text-muted-foreground">The document is read-only until it finishes. Comments still work.</span>
      <Button size="xs" variant="outline" className="ml-auto" disabled={!turnId || busy} onClick={() => void stop()}>
        <SquareIcon />
        Stop
      </Button>
      {error ? (
        <p role="alert" className="w-full text-xs text-destructive-foreground">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/**
 * The run this view saw holding the document, once it has ended, until the
 * person dismisses the notice. Runs that ended before the document was
 * opened are not announced.
 */
export function useEndedRun(lockedRunId: string | null, run: ScribeRun | null | undefined) {
  const [watching, setWatching] = useState<string | null>(null);
  useEffect(() => {
    if (lockedRunId) setWatching(lockedRunId);
  }, [lockedRunId]);
  const ended = watching && run?.runId === watching && run.status !== 'running' ? run : null;
  return { ended, dismiss: () => setWatching(null) };
}

interface ScribeNoticeProps {
  run: ScribeRun;
  names: Names;
  onOpenHistory: (changeSetId: string) => void;
  onDismiss: () => void;
}

/** How a run ended: committed, with its history entry, or stopped or failed with the document unchanged. */
export function ScribeNotice({ run, names, onOpenHistory, onDismiss }: ScribeNoticeProps) {
  const scribe = names(run.participantId);
  let text: string;
  if (run.status === 'committed') {
    text = run.changeSetId ? `${scribe} finished the scribe run. Its changes are one entry in history.` : `${scribe} finished the scribe run without changing the document.`;
  } else if (run.stoppedByParticipantId) {
    text = `${names(run.stoppedByParticipantId)} stopped the scribe run. The document is unchanged.`;
  } else {
    text = `The scribe run failed${run.releaseReason ? `: ${run.releaseReason}` : ''}. The document is unchanged.`;
  }
  const changeSetId = run.status === 'committed' ? run.changeSetId : undefined;

  return (
    <div role="status" aria-label="Scribe run ended" className="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-sm">
      <span>{text}</span>
      {changeSetId ? (
        <Button size="xs" variant="link" onClick={() => onOpenHistory(changeSetId)}>
          See it in history
        </Button>
      ) : null}
      <Button size="icon-xs" variant="ghost-muted" className="ml-auto" aria-label="Dismiss" onClick={onDismiss}>
        <XIcon />
      </Button>
    </div>
  );
}
