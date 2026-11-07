import { api } from "@atelier/backend/api";
import type { Id } from "@atelier/backend/dataModel";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { ArrowLeftIcon, HistoryIcon, RotateCcwIcon } from "lucide-react";
import { useState } from "react";

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
import { entryText, markedVersion } from "~/lib/document";
import type { ChangeSetEntry } from "~/lib/document";
import type { Names } from "~/lib/room";
import { hasContent, logFailure } from "~/lib/utils";

import { VersionView } from "./VersionView";

const PAGE_SIZE = 20;

/** When a change set was made, with the day, since history spans many. */
const whenText = (at: number) =>
  new Date(at).toLocaleString([], {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
  });
/** Whether the history panel is open, and the version it opened at, if one was asked for. */
export type HistoryView =
  | { open: false }
  | { open: true; changeSetId?: string };
interface HistoryControlProps {
  roomId: Id<"rooms">;
  names: Names;
  view: HistoryView;
  onView: (view: HistoryView) => void;
}

const RestoreVersion = ({
  changeSetId,
  onRestored,
}: {
  changeSetId: Id<"changeSets">;
  onRestored: () => void;
}) => {
  const restore = useMutation(api.history.restore);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await restore({ changeSetId });
      onRestored();
    } catch (error_) {
      setError(errorText(error_));
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1.5">
      {confirming ? (
        <fieldset
          aria-label="Confirm restore"
          className="bg-card min-w-0 space-y-1.5 rounded-lg border p-2.5 text-sm"
        >
          <p>
            Restore the document to this version? The current document is saved
            as a version first, so nothing is lost. Comment threads stay where
            they are and follow the restored text.
          </p>
          <div className="flex items-center gap-1.5">
            <Button
              size="xs"
              disabled={busy}
              onClick={() => {
                confirm().catch(logFailure);
              }}
            >
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
        </fieldset>
      ) : (
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            setConfirming(true);
          }}
        >
          <RotateCcwIcon />
          Restore this version
        </Button>
      )}
      {hasContent(error) ? (
        <p role="alert" className="text-destructive-foreground text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
};

/** One version, read-only, with the blocks its change set touched marked, and its restore. */
const SelectedVersion = ({
  entry,
  names,
  isCurrent,
  onBack,
  onRestored,
}: SelectedVersionProps) => {
  const changeSetId = entry._id;
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
        <p className="text-muted-foreground text-xs">{whenText(entry.at)}</p>
      </div>
      {isCurrent ? (
        <p className="text-muted-foreground text-xs">
          This is the document as it is now.
        </p>
      ) : (
        <RestoreVersion changeSetId={changeSetId} onRestored={onRestored} />
      )}
      {version === undefined || diff === undefined ? (
        <PageSpinner />
      ) : (
        <VersionView
          blocks={markedVersion(version.blocks, diff)}
          names={names}
        />
      )}
    </section>
  );
};

const HistoryBody = ({
  roomId,
  names,
  initialChangeSetId,
}: {
  roomId: Id<"rooms">;
  names: Names;
  initialChangeSetId?: string;
}) => {
  const { results, status, loadMore } = usePaginatedQuery(
    api.history.list,
    { roomId },
    { initialNumItems: PAGE_SIZE }
  );
  // A version asked for when opening shows once its entry has loaded; one
  // past the loaded pages leaves the list showing.
  const [selectedId, setSelectedId] = useState<string | null>(
    initialChangeSetId ?? null
  );
  const selected =
    selectedId === null
      ? null
      : (results.find((e) => e._id === selectedId) ?? null);
  const setSelected = (entry: ChangeSetEntry | null) => {
    setSelectedId(entry?._id ?? null);
  };
  const [restored, setRestored] = useState<ChangeSetEntry | null>(null);

  if (status === "LoadingFirstPage") {
    return <PageSpinner />;
  }

  if (selected) {
    return (
      <SelectedVersion
        entry={selected}
        names={names}
        isCurrent={selected._id === results[0]?._id}
        onBack={() => {
          setSelected(null);
        }}
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
        <output className="text-muted-foreground block text-xs">
          Restored the version from {whenText(restored.at)}. The document as it
          was before is saved in history.
        </output>
      ) : null}
      {results.length === 0 ? (
        <p className="text-muted-foreground text-sm">No changes yet.</p>
      ) : (
        <ol aria-label="Versions" className="space-y-0.5">
          {results.map((entry) => (
            <li key={entry._id}>
              <button
                type="button"
                className="hover:bg-accent flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-sm"
                onClick={() => {
                  setRestored(null);
                  setSelected(entry);
                }}
              >
                <span data-entry-title="" className="font-medium">
                  {entryText(entry, names)}
                </span>
                <span className="text-muted-foreground ml-auto shrink-0 text-xs">
                  {whenText(entry.at)}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
      {status === "CanLoadMore" || status === "LoadingMore" ? (
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={status === "LoadingMore"}
          onClick={() => {
            loadMore(PAGE_SIZE);
          }}
        >
          Load older versions
        </Button>
      ) : null}
    </div>
  );
};

/** The document header's History button and the panel it opens. */
export const HistoryControl = ({
  roomId,
  names,
  view,
  onView,
}: HistoryControlProps) => {
  const { open } = view;
  return (
    <>
      <Button
        size="xs"
        variant="ghost-muted"
        onClick={() => {
          onView({ open: true });
        }}
      >
        <HistoryIcon />
        History
      </Button>
      <Sheet
        open={open}
        onOpenChange={(next) => {
          onView(next ? { open: true } : { open: false });
        }}
      >
        <SheetPopup
          side="right"
          className="w-[min(92vw,40rem)] max-w-none overflow-y-auto"
        >
          <SheetHeader>
            <SheetTitle>History</SheetTitle>
            <SheetDescription>
              Every change to the document, newest first. Pick one to see the
              document as it stood then.
            </SheetDescription>
          </SheetHeader>
          {view.open ? (
            <HistoryBody
              key={view.changeSetId ?? ""}
              roomId={roomId}
              names={names}
              initialChangeSetId={view.changeSetId}
            />
          ) : null}
        </SheetPopup>
      </Sheet>
    </>
  );
};

interface SelectedVersionProps {
  entry: ChangeSetEntry;
  names: Names;
  /** The newest change set: the document as it is now, so there is nothing to restore. */
  isCurrent: boolean;
  onBack: () => void;
  onRestored: () => void;
}
