import { api } from '@atelier/backend/api';
import type { Id } from '@atelier/backend/dataModel';
import { useMutation } from 'convex/react';
import { Button } from '~/components/ui/button';
import { Textarea } from '~/components/ui/textarea';
import { useComposer } from './useComposer';

/** Writes to the people in the room only. Enter sends only from this box, and focus stays here. */
export function TeamComposer({ roomId }: { roomId: Id<'rooms'> }) {
  const post = useMutation(api.team.post);
  const { draft, setDraft, busy, error, submit, onKeyDown } = useComposer((body) => post({ roomId, body }));

  return (
    <div className="space-y-2">
      <Textarea
        aria-label="To team only"
        placeholder="To team only. Agents never see this."
        rows={2}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="flex items-center justify-end gap-2">
        {error ? <p className="mr-auto text-xs text-destructive-foreground">{error}</p> : null}
        <Button size="sm" variant="secondary" disabled={!draft.trim() || busy} onClick={() => void submit()}>
          Send to team
        </Button>
      </div>
    </div>
  );
}
