import { api } from '@atelier/backend/api';
import type { Id } from '@atelier/backend/dataModel';
import { useMutation, useQuery } from 'convex/react';
import { FileTextIcon, PlusIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { PageSpinner } from '~/components/page';
import { errorText } from '~/components/room/errors';
import { Button } from '~/components/ui/button';
import { leaseHolder, sectionsOf, type Section } from '~/lib/document';
import { useNow, type Names } from '~/lib/room';
import { AddChoices, Block, type AddPlace } from './Block';

interface DocumentPaneProps {
  roomId: Id<'rooms'>;
  names: Names;
  /** The person's own participant in this room. */
  meId: string | null;
}

/** The room's shared document, edited one block at a time. */
export function DocumentPane({ roomId, names, meId }: DocumentPaneProps) {
  const doc = useQuery(api.documents.get, { roomId });
  const ensure = useMutation(api.documents.ensure);
  const [ensureError, setEnsureError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<Id<'blocks'> | null>(null);
  // Leases lapse on the clock; re-check who holds a block now and then.
  const now = useNow(10_000);

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
      <div className="mx-auto max-w-3xl space-y-4 px-4 py-5">
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
    );
  }

  return (
    <section aria-label="Room document" className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b px-4 py-2.5">
        <FileTextIcon className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Document</h2>
        <span className="text-xs text-muted-foreground">Shared with everyone in the room, agents included.</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
    </section>
  );
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
