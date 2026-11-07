import { api } from '@atelier/backend/api';
import type { Id } from '@atelier/backend/dataModel';
import { useMutation, usePaginatedQuery, useQuery } from 'convex/react';
import { ArrowLeftIcon, HistoryIcon, RotateCcwIcon } from 'lucide-react';
import { useState } from 'react';
import { PageSpinner } from '~/components/page';
import { errorText } from '~/components/room/errors';
import { Button } from '~/components/ui/button';
import { Sheet, SheetDescription, SheetHeader, SheetPopup, SheetTitle } from '~/components/ui/sheet';
import { entryText, markedVersion, type ChangeSetEntry } from '~/lib/document';
import type { Names } from '~/lib/room';
import { VersionView } from './VersionView';

const PAGE_SIZE = 20;

/** When a change set was made, with the day, since history spans many. */
function whenText(at: number) {
  return new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Whether the history panel is open, and the version it opened at, if one was asked for. */
export type HistoryView = { open: false } | { open: true; changeSetId?: string };

interface HistoryControlProps {
  roomId: Id<'rooms'>;
  names: Names;
  view: HistoryView;
  onView: (view: HistoryView) => void;
}

/** The document header's History button and the panel it opens. */
export function HistoryControl({ roomId, names, view, onView }: HistoryControlProps) {
  const open = view.open;
  return (
    <>
      <Button size="xs" variant="ghost-muted" onClick={() => onView({ open: true })}>
        <HistoryIcon />
        History
      </Button>
      <Sheet open={open} onOpenChange={(next) => onView(next ? { open: true } : { open: false })}>
        <SheetPopup side="right" className="w-[min(92vw,40rem)] max-w-none overflow-y-auto">
          <SheetHeader>
            <SheetTitle>History</SheetTitle>
            <SheetDescription>Every change to the document, newest first. Pick one to see the document as it stood then.</SheetDescription>
          </SheetHeader>
          {view.open ? <HistoryBody key={view.changeSetId ?? ''} roomId={roomId} names={names} initialChangeSetId={view.changeSetId} /> : null}
        </SheetPopup>
      </Sheet>
    </>
  );
}

function HistoryBody({ roomId, names, initialChangeSetId }: { roomId: Id<'rooms'>; names: Names; initialChangeSetId?: string }) {
  const { results, status, loadMore } = usePaginatedQuery(api.history.list, { roomId }, { initialNumItems: PAGE_SIZE });
  // A version asked for when opening shows once its entry has loaded; one
  // past the loaded pages leaves the list showing.
  const [selectedId, setSelectedId] = useState<string | null>(initialChangeSetId ?? null);
  const selected = selectedId ? (results.find((e) => e._id === selectedId) ?? null) : null;
  const setSelected = (entry: ChangeSetEntry | null) => setSelectedId(entry?._id ?? null);
  const [restored, setRestored] = useState<ChangeSetEntry | null>(null);

  if (status === 'LoadingFirstPage') return <PageSpinner />;

  if (selected) {
    return (
      <SelectedVersion
        entry={selected}
        names={names}
        isCurrent={selected._id === results[0]?._id}
        onBack={() => setSelected(null)}
        onRestored={() => {
          setRestored(selected);
          setSelected(null);
        }}
      />
    );
  }

  return (
    <div className="space-y-3 px-6 pb-6">
      {restored ? (
        <p role="status" className="text-xs text-muted-foreground">
          Restored the version from {whenText(restored.at)}. The document as it was before is saved in history.
        </p>
      ) : null}
      {results.length === 0 ? (
        <p className="text-sm text-muted-foreground">No changes yet.</p>
      ) : (
        <ol aria-label="Versions" className="space-y-0.5">
          {results.map((entry) => (
            <li key={entry._id}>
              <button
                type="button"
                className="flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                onClick={() => {
                  setRestored(null);
                  setSelected(entry);
                }}
              >
                <span data-entry-title="" className="font-medium">
                  {entryText(entry, names)}
                </span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">{whenText(entry.at)}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
      {status === 'CanLoadMore' || status === 'LoadingMore' ? (
        <Button size="xs" variant="ghost-muted" disabled={status === 'LoadingMore'} onClick={() => loadMore(PAGE_SIZE)}>
          Load older versions
        </Button>
      ) : null}
    </div>
  );
}

interface SelectedVersionProps {
  entry: ChangeSetEntry;
  names: Names;
  /** The newest change set: the document as it is now, so there is nothing to restore. */
  isCurrent: boolean;
  onBack: () => void;
  onRestored: () => void;
}

/** One version, read-only, with the blocks its change set touched marked, and its restore. */
function SelectedVersion({ entry, names, isCurrent, onBack, onRestored }: SelectedVersionProps) {
  const changeSetId = entry._id as Id<'changeSets'>;
  const version = useQuery(api.history.version, { changeSetId });
  const diff = useQuery(api.history.diff, { changeSetId });
  const title = entryText(entry, names);

  return (
    <section aria-label={`Version: ${title}`} className="space-y-3 px-6 pb-6">
      <div className="flex items-center gap-2">
        <Button size="xs" variant="ghost-muted" onClick={onBack}>
          <ArrowLeftIcon />
          All versions
        </Button>
      </div>
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="text-xs text-muted-foreground">{whenText(entry.at)}</p>
      </div>
      {isCurrent ? (
        <p className="text-xs text-muted-foreground">This is the document as it is now.</p>
      ) : (
        <RestoreVersion changeSetId={changeSetId} onRestored={onRestored} />
      )}
      {version === undefined || diff === undefined ? <PageSpinner /> : <VersionView blocks={markedVersion(version.blocks, diff)} names={names} />}
    </section>
  );
}

function RestoreVersion({ changeSetId, onRestored }: { changeSetId: Id<'changeSets'>; onRestored: () => void }) {
  const restore = useMutation(api.history.restore);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await restore({ changeSetId });
      onRestored();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1.5">
      {confirming ? (
        <div role="group" aria-label="Confirm restore" className="space-y-1.5 rounded-lg border bg-card p-2.5 text-sm">
          <p>
            Restore the document to this version? The current document is saved as a version first, so nothing is lost. Comment threads stay where
            they are and follow the restored text.
          </p>
          <div className="flex items-center gap-1.5">
            <Button size="xs" disabled={busy} onClick={() => void confirm()}>
              Restore
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                setConfirming(false);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button size="xs" variant="outline" onClick={() => setConfirming(true)}>
          <RotateCcwIcon />
          Restore this version
        </Button>
      )}
      {error ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {error}
        </p>
      ) : null}
    </div>
  );
}
