import { api } from '@atelier/backend/api';
import type { Id } from '@atelier/backend/dataModel';
import { useMutation } from 'convex/react';
import { useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { errorText } from '~/components/room/errors';
import { Button } from '~/components/ui/button';
import { Textarea } from '~/components/ui/textarea';
import { KIND_LABEL, RENEW_EVERY_MS, type DocBlock } from '~/lib/document';

interface BlockEditorProps {
  block: DocBlock;
  /** Someone else who now holds an unexpired lease on the block. */
  otherHolder: string | null;
  onDone: () => void;
}

/**
 * The block being edited, while the person holds its lease. Enter or leaving
 * the textarea saves and ends the edit; Shift+Enter adds a line. A refused
 * save keeps the draft here with the server's reason.
 */
export function BlockEditor({ block, otherHolder, onDone }: BlockEditorProps) {
  const blockId = block._id as Id<'blocks'>;
  const save = useMutation(api.blocks.save);
  const renew = useMutation(api.blocks.renew);
  const stopEdit = useMutation(api.blocks.stopEdit);
  const startEdit = useMutation(api.blocks.startEdit);
  const [draft, setDraft] = useState(block.text);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const busy = useRef(false);
  const lastRenewal = useRef(Date.now());
  const boxRef = useRef<HTMLDivElement>(null);

  const onChange = (value: string) => {
    setDraft(value);
    if (Date.now() - lastRenewal.current < RENEW_EVERY_MS) return;
    lastRenewal.current = Date.now();
    renew({ blockId }).catch((e: unknown) => setError(errorText(e)));
  };

  const finish = async () => {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    try {
      if (draft !== block.text) await save({ blockId, text: draft });
      await stopEdit({ blockId });
      onDone();
    } catch (e) {
      setError(errorText(e));
    }
    busy.current = false;
  };

  const retake = async () => {
    setError(null);
    try {
      await startEdit({ blockId });
      lastRenewal.current = Date.now();
      boxRef.current?.querySelector('textarea')?.focus();
    } catch (e) {
      setError(errorText(e));
    }
  };

  // Gives up the draft. A lease still held is released; one that is not
  // lapses on its own, so a failed release changes nothing.
  const discard = () => {
    stopEdit({ blockId }).catch(() => {});
    onDone();
  };

  const copyDraft = async () => {
    await navigator.clipboard.writeText(draft);
    setCopied(true);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void finish();
  };

  const onBlur = (e: FocusEvent<HTMLTextAreaElement>) => {
    // Moving to this editor's own buttons is not leaving it, and a refused
    // save waits for the person to choose what to do.
    if (boxRef.current?.contains(e.relatedTarget as Node | null) || error) return;
    void finish();
  };

  return (
    <div ref={boxRef} className="space-y-1.5">
      <Textarea
        aria-label={`Edit ${KIND_LABEL[block.kind].toLowerCase()}`}
        autoFocus
        rows={block.kind === 'paragraph' ? 3 : 1}
        value={draft}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
      />
      {error ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <p role="alert" className="mr-auto text-destructive-foreground">
            {error}
          </p>
          {otherHolder ? (
            <Button size="xs" variant="outline" onClick={() => void copyDraft()}>
              {copied ? 'Copied' : 'Copy my draft'}
            </Button>
          ) : (
            <Button size="xs" variant="outline" onClick={() => void retake()}>
              Retake the block
            </Button>
          )}
          <Button size="xs" variant="ghost" onClick={discard}>
            Discard my draft
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Enter saves · Shift+Enter adds a line</p>
      )}
    </div>
  );
}
