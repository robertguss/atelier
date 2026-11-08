import { api } from "@atelier/backend/api";
import type { Id } from "@atelier/backend/dataModel";
import { DOCUMENT_BLOCKS, numberedPositions } from "@atelier/shared";
import { useMutation, useQuery } from "convex/react";
import { FileTextIcon } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { RefObject, SyntheticEvent } from "react";

import { PageSpinner } from "~/components/page";
import { errorText } from "~/components/room/errors";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { leaseHolder, scribeLocked, sectionsOf } from "~/lib/document";
import type { DocBlock, Passage, Section, ThreadsData } from "~/lib/document";
import { createSession } from "~/lib/editor/session";
import { useNow } from "~/lib/room";
import type { Names, Participant } from "~/lib/room";
import { renderedRange, selectionIn, sourceRange } from "~/lib/selection";
import { hasContent, logFailure } from "~/lib/utils";

import { Block } from "./Block";
import type { CaretRequest } from "./Block";
import { useBlockMoves } from "./DragHandle";
import { HistoryControl } from "./HistoryPanel";
import type { HistoryView } from "./HistoryPanel";
import {
  ScribeBanner,
  ScribeControl,
  ScribeNotice,
  useEndedRun,
} from "./ScribeControl";
import { ThreadMargin } from "./ThreadMargin";
import { FULL } from "./useBlockActions";

// Names of the CSS highlights that mark commented passages and the one a
// new comment is being written on; index.css styles them.
const COMMENT_HIGHLIGHT = "atelier-comment";
const DRAFT_HIGHLIGHT = "atelier-comment-draft";

interface DocumentPaneProps {
  roomId: Id<"rooms">;
  names: Names;
  /** The person's own participant in this room. */
  meId: string | null;
  /** The room's model participants, offered as mentions in comments and as the scribe. */
  models: readonly Participant[];
  /** Only the owner writes templates. */
  isOwner: boolean;
}

/** The passage of a block the reader has selected, editable or not, as offsets in its stored text. */
const useBlockSelection = (
  blocks: readonly DocBlock[] | undefined
): Passage | null => {
  const [selected, setSelected] = useState<Passage | null>(null);
  const blocksRef = useRef(blocks);
  useEffect(() => {
    blocksRef.current = blocks;
  });
  useEffect(() => {
    const onChange = () => {
      const selection = document.getSelection();
      const anchor = selection?.anchorNode;
      const element = (
        anchor instanceof Element ? anchor : anchor?.parentElement
      )?.closest<HTMLElement>("[data-block-text]");
      const block =
        element &&
        blocksRef.current?.find((b) => b._id === element.dataset.blockText);
      const read = element && selectionIn(element, selection ?? null);
      const range =
        block && read
          ? sourceRange(block.text, read.selected, read.before)
          : null;
      const next = block && range ? { blockId: block._id, ...range } : null;
      setSelected((current) =>
        current?.blockId === next?.blockId &&
        current?.start === next?.start &&
        current?.end === next?.end
          ? current
          : next
      );
    };
    document.addEventListener("selectionchange", onChange);
    return () => {
      document.removeEventListener("selectionchange", onChange);
    };
  }, []);
  return selected;
};

/**
 * Marks the passages of open threads, and of the comment being written,
 * with the CSS Custom Highlight API, so the rendered text is left as it is.
 * Browsers without the API show no marks.
 */
const markPassages = (
  root: HTMLElement,
  registry: HighlightRegistry,
  blocks: readonly DocBlock[] | undefined,
  threads: ThreadsData | undefined,
  draft: Passage | null
) => {
  const byId = new Map<string, DocBlock>((blocks ?? []).map((b) => [b._id, b]));
  const rangeOf = (blockId: string, start: number, end: number) => {
    const block = byId.get(blockId);
    const element = root.querySelector(`[data-block-text="${blockId}"]`);
    return block && element
      ? renderedRange(element, block.text, start, end)
      : null;
  };
  const marked = (threads?.open ?? [])
    .filter((t) => !t.detachedBeforeChangeSetId)
    .map((t) => rangeOf(t.blockId, t.position, t.position + t.exact.length))
    .filter((r): r is Range => r !== null);
  registry.set(COMMENT_HIGHLIGHT, new Highlight(...marked));
  const drafting = draft && rangeOf(draft.blockId, draft.start, draft.end);
  if (drafting) {
    registry.set(DRAFT_HIGHLIGHT, new Highlight(drafting));
  } else {
    registry.delete(DRAFT_HIGHLIGHT);
  }
};

const useCommentHighlights = (
  rootRef: RefObject<HTMLElement | null>,
  blocks: readonly DocBlock[] | undefined,
  threads: ThreadsData | undefined,
  draft: Passage | null
) => {
  useEffect(() => {
    const root = rootRef.current;
    const registry =
      typeof CSS !== "undefined" &&
      "highlights" in CSS &&
      typeof Highlight !== "undefined"
        ? CSS.highlights
        : null;
    const mark = () => {
      if (root && registry) {
        markPassages(root, registry, blocks, threads, draft);
      }
    };
    // An editor replacing a block's static text, or a transaction in one,
    // swaps the text nodes the marks point into, without a render here.
    const observer = new MutationObserver(mark);
    if (root && registry) {
      mark();
      observer.observe(root, {
        characterData: true,
        childList: true,
        subtree: true,
      });
    }
    return () => {
      observer.disconnect();
      registry?.delete(COMMENT_HIGHLIGHT);
      registry?.delete(DRAFT_HIGHLIGHT);
    };
  }, [rootRef, blocks, threads, draft]);
};

const sectionBlocks = (section: Section) =>
  section.heading ? [section.heading, ...section.blocks] : section.blocks;
/** Saves the document's headings, and any template guidance under them, as a new template. */
const SaveAsTemplate = ({ roomId }: { roomId: Id<"rooms"> }) => {
  const save = useMutation(api.templates.saveFromRoom);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const submit = async (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!name.trim()) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await save({ name: name.trim(), roomId });
      setSaved(name.trim());
      setName("");
      setOpen(false);
    } catch (error_) {
      setError(errorText(error_));
    }
    setBusy(false);
  };

  if (!open) {
    return (
      <div className="flex items-center gap-2">
        {saved === null ? null : (
          <span className="text-muted-foreground text-xs">
            “{saved}” saved as a template.
          </span>
        )}
        <Button
          size="xs"
          variant="ghost-muted"
          onClick={() => {
            setSaved(null);
            setOpen(true);
          }}
        >
          Save as template
        </Button>
      </div>
    );
  }
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        submit(e).catch(logFailure);
      }}
    >
      {hasContent(error) ? (
        <span className="text-destructive-foreground text-xs">{error}</span>
      ) : null}
      <Input
        size="sm"
        aria-label="Template name"
        placeholder="Template name"
        value={name}
        onChange={(e) => {
          setName(e.target.value);
        }}
        autoFocus
      />
      <Button type="submit" size="xs" disabled={!name.trim() || busy}>
        Save
      </Button>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        onClick={() => {
          setOpen(false);
        }}
      >
        Cancel
      </Button>
    </form>
  );
};

/** The room's shared document, edited one block at a time. */
export const DocumentPane = ({
  roomId,
  names,
  meId,
  models,
  isOwner,
}: DocumentPaneProps) => {
  const doc = useQuery(api.documents.get, { roomId });
  const threads = useQuery(api.threads.list, { roomId });
  const scribeRun = useQuery(api.scribe.latest, { roomId });
  const ensure = useMutation(api.documents.ensure);
  const [ensureError, setEnsureError] = useState<string | null>(null);
  const startEdit = useMutation(api.blocks.startEdit);
  const stopEdit = useMutation(api.blocks.stopEdit);
  const save = useMutation(api.blocks.save);
  const split = useMutation(api.blockOps.split);
  const insertMany = useMutation(api.blockOps.insertMany);
  // Convex hands back the same mutation functions on every render, so the
  // session lives as long as the pane.
  const session = useMemo(
    () =>
      createSession(
        { save, split, startEdit, stopEdit },
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a split's new block goes by this key until the server returns its id, and the session swaps it for that id before any call
        (n) => `temp-${n}` as Id<"blocks">
      ),
    [save, split, startEdit, stopEdit]
  );
  // Split blocks the server has not returned yet.
  useSyncExternalStore(session.subscribe, session.temps);
  const moves = useBlockMoves(session);
  const [caret, setCaret] = useState<CaretRequest | undefined>();
  const [appendError, setAppendError] = useState<string | null>(null);
  // Leases lapse on the clock; re-check who holds a block now and then.
  const now = useNow(10_000);
  const blocks = doc?.blocks;
  const selected = useBlockSelection(blocks);
  const [commentDraft, setCommentDraft] = useState<Passage | null>(null);
  const textRef = useRef<HTMLDivElement>(null);
  useCommentHighlights(textRef, blocks, threads, commentDraft);
  const [historyView, setHistoryView] = useState<HistoryView>({ open: false });
  // While a scribe run holds the document, nobody edits, adds, moves or deletes blocks; comments still work.
  const locked = !!doc && scribeLocked(doc, now);
  const lockedRunId = locked ? (doc.scribeRunId ?? null) : null;
  const { ended, dismiss } = useEndedRun(lockedRunId, scribeRun);

  // Rooms made before documents existed get theirs seeded on first open.
  const ensuredFor = useRef<string | null>(null);
  useEffect(() => {
    if (ensuredFor.current === roomId) {
      return;
    }
    ensuredFor.current = roomId;
    ensure({ roomId }).catch((error_: unknown) => {
      setEnsureError(errorText(error_));
    });
  }, [ensure, roomId]);

  // A hidden tab or a closed pane saves what was typed and releases its lease.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        session.hide();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      session.hide();
    };
  }, [session]);

  // A click below the last block adds an empty paragraph there, leased to
  // the person, who starts typing in it.
  const append = async (last: DocBlock | undefined) => {
    setAppendError(null);
    const after = last && session.keyOf(last._id);
    await session.run(
      last && after ? [[after, last.rev]] : [],
      async (find) => {
        const inserted = await insertMany({
          afterBlockId: after === undefined ? null : find(after).id,
          blocks: [{ kind: "paragraph", text: "" }],
          roomId,
        });
        for (const { blockId } of inserted.blocks) {
          session.leased(blockId);
          setCaret({ at: "start", key: blockId });
        }
        return [];
      }
    );
  };

  let body;
  if (doc === undefined || (doc === null && !hasContent(ensureError))) {
    body = <PageSpinner />;
  } else if (doc === null) {
    body = (
      <p
        role="alert"
        className="text-destructive-foreground py-6 text-center text-sm"
      >
        {ensureError}
      </p>
    );
  } else {
    const shown = session.blocks(doc.blocks, (temp, head) => ({
      ...head,
      _id: temp.key,
      checked: temp.checked,
      kind: temp.kind,
      openThreads: 0,
      rev: 0,
      text: temp.text,
    }));
    const numbers = numberedPositions(shown.map((b) => b.kind));
    const full = shown.length >= DOCUMENT_BLOCKS;
    const indexOf = new Map(shown.map((b, i) => [b._id, i]));
    const heldByOther = (other: DocBlock | undefined) => {
      const holder = other ? leaseHolder(other, now) : null;
      return holder === null || holder === meId ? null : names(holder);
    };
    body = (
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-5 @4xl:flex-row @4xl:items-start">
        <div
          ref={textRef}
          className="w-full max-w-3xl min-w-0 flex-1 space-y-4"
        >
          {sectionsOf(shown).map((section, index) => (
            <div
              key={section.heading?._id ?? `loose-${index}`}
              className="space-y-0.5"
            >
              {sectionBlocks(section).map((block) => {
                const at = indexOf.get(block._id) ?? 0;
                const key = session.keyOf(block._id);
                return (
                  <Block
                    key={key}
                    roomId={roomId}
                    block={block}
                    names={names}
                    meId={meId}
                    holderId={leaseHolder(block, now)}
                    locked={locked}
                    position={at}
                    count={shown.length}
                    onMove={async (to) => {
                      await moves.move(shown, at, to);
                    }}
                    handleFocus={
                      moves.focus?.key === key ? moves.focus : undefined
                    }
                    full={full}
                    previous={shown[at - 1] ?? null}
                    next={shown[at + 1] ?? null}
                    previousHeldBy={heldByOther(shown[at - 1])}
                    number={numbers[at]}
                    session={session}
                    sessionKey={key}
                    caret={caret?.key === key ? caret : undefined}
                    onCaret={(target, caretAt) => {
                      setCaret({ at: caretAt, key: target });
                    }}
                    models={models}
                    commentable={selected?.blockId === block._id}
                    onComment={() => {
                      setCommentDraft(selected);
                    }}
                    commentDraft={
                      commentDraft?.blockId === block._id ? commentDraft : null
                    }
                    onCommentDone={() => {
                      setCommentDraft(null);
                    }}
                  />
                );
              })}
            </div>
          ))}
          <p aria-live="polite" className="sr-only">
            {moves.announcement}
          </p>
          {full ? (
            <p className="text-muted-foreground text-xs">{FULL}</p>
          ) : null}
          <button
            type="button"
            aria-label="Add a paragraph at the end"
            disabled={locked || full}
            className="block min-h-24 w-full cursor-text"
            onClick={() => {
              append(shown.at(-1)).catch((error_: unknown) => {
                setAppendError(errorText(error_));
              });
            }}
          />
          {hasContent(appendError) ? (
            <p role="alert" className="text-destructive-foreground text-xs">
              {appendError}
            </p>
          ) : null}
        </div>
        {threads ? (
          <ThreadMargin
            threads={threads}
            blocks={doc.blocks}
            names={names}
            models={models}
            className="w-full @4xl:w-72 @4xl:shrink-0"
          />
        ) : null}
      </div>
    );
  }

  return (
    <section
      aria-label="Room document"
      className="flex h-full min-h-0 flex-col"
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-4 py-2.5">
        <FileTextIcon className="text-muted-foreground size-4" />
        <h2 className="text-sm font-medium">Document</h2>
        <span className="text-muted-foreground hidden text-xs sm:inline">
          Shared with everyone in the room, agents included.
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          <ScribeControl roomId={roomId} models={models} locked={locked} />
          <HistoryControl
            roomId={roomId}
            names={names}
            view={historyView}
            onView={setHistoryView}
          />
          {isOwner ? <SaveAsTemplate roomId={roomId} /> : null}
        </div>
      </header>
      {locked ? (
        <ScribeBanner
          run={scribeRun?.runId === doc.scribeRunId ? scribeRun : undefined}
          names={names}
        />
      ) : null}
      {ended && !locked ? (
        <ScribeNotice
          run={ended}
          names={names}
          onOpenHistory={(changeSetId) => {
            setHistoryView({ changeSetId, open: true });
          }}
          onDismiss={dismiss}
        />
      ) : null}
      <div className="@container min-h-0 flex-1 overflow-y-auto">{body}</div>
    </section>
  );
};
