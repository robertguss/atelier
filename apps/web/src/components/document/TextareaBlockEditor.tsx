import { api } from "@atelier/backend/api";
import { useMutation } from "convex/react";
import { useEffect, useRef, useState } from "react";
import type { FocusEvent, KeyboardEvent } from "react";

import { errorText } from "~/components/room/errors";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { KIND_LABEL, RENEW_EVERY_MS } from "~/lib/document";
import type { DocBlock } from "~/lib/document";
import { hasContent, logFailure } from "~/lib/utils";

interface TextareaBlockEditorProps {
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
export const TextareaBlockEditor = ({
  block,
  otherHolder,
  onDone,
}: TextareaBlockEditorProps) => {
  const blockId = block._id;
  const save = useMutation(api.blocks.save);
  const renew = useMutation(api.blocks.renew);
  const stopEdit = useMutation(api.blocks.stopEdit);
  const startEdit = useMutation(api.blocks.startEdit);
  const [draft, setDraft] = useState(block.text);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const busy = useRef(false);
  const lastRenewal = useRef(0);
  const boxRef = useRef<HTMLDivElement>(null);
  // The lease was taken just before this editor opened.
  useEffect(() => {
    lastRenewal.current = Date.now();
  }, []);

  const onChange = (value: string) => {
    setDraft(value);
    if (Date.now() - lastRenewal.current < RENEW_EVERY_MS) {
      return;
    }
    lastRenewal.current = Date.now();
    renew({ blockId }).catch((error_: unknown) => {
      setError(errorText(error_));
    });
  };

  const finish = async () => {
    if (busy.current) {
      return;
    }
    busy.current = true;
    setError(null);
    try {
      if (draft !== block.text) {
        await save({ blockId, text: draft });
      }
      await stopEdit({ blockId });
      onDone();
    } catch (error_) {
      setError(errorText(error_));
    }
    busy.current = false;
  };

  const retake = async () => {
    setError(null);
    try {
      await startEdit({ blockId });
      lastRenewal.current = Date.now();
      boxRef.current?.querySelector("textarea")?.focus();
    } catch (error_) {
      setError(errorText(error_));
    }
  };

  // Gives up the draft. A lease still held is released; one that is not
  // lapses on its own, so a failed release changes nothing.
  const discard = () => {
    stopEdit({ blockId }).catch(() => {
      // The lease lapses on its own.
    });
    onDone();
  };

  const copyDraft = async () => {
    await navigator.clipboard.writeText(draft);
    setCopied(true);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) {
      return;
    }
    e.preventDefault();
    finish().catch(logFailure);
  };

  const onBlur = (e: FocusEvent<HTMLTextAreaElement>) => {
    // Moving to this editor's own buttons is not leaving it, and a refused
    // save waits for the person to choose what to do.
    if (
      boxRef.current?.contains(e.relatedTarget) === true ||
      hasContent(error)
    ) {
      return;
    }
    finish().catch(logFailure);
  };

  return (
    <div ref={boxRef} className="space-y-1.5">
      <Textarea
        aria-label={`Edit ${KIND_LABEL[block.kind].toLowerCase()}`}
        autoFocus
        rows={block.kind === "paragraph" ? 3 : 1}
        value={draft}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
      />
      {hasContent(error) ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <p role="alert" className="text-destructive-foreground mr-auto">
            {error}
          </p>
          {hasContent(otherHolder) ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                copyDraft().catch(logFailure);
              }}
            >
              {copied ? "Copied" : "Copy my draft"}
            </Button>
          ) : (
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                retake().catch(logFailure);
              }}
            >
              Retake the block
            </Button>
          )}
          <Button size="xs" variant="ghost" onClick={discard}>
            Discard my draft
          </Button>
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">
          Enter saves · Shift+Enter adds a line
        </p>
      )}
    </div>
  );
};
