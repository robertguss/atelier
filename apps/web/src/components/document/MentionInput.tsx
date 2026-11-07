import { useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

import { Textarea } from "~/components/ui/textarea";
import type { Participant } from "~/lib/room";
import { cn } from "~/lib/utils";

interface MentionInputProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** The room's model participants, offered after an @. */
  models: readonly Participant[];
  /** Enter submits; Shift+Enter adds a line. */
  onSubmit: () => void;
  placeholder?: string;
  autoFocus?: boolean;
}

// The @name being typed just before the caret, if any.
const MENTION = /(?:^|[^\p{L}\p{N}_@])@(?<name>[^\s@]*)$/u;

const mentionQuery = (text: string, caret: number) => {
  const name = MENTION.exec(text.slice(0, caret))?.groups?.name;
  return name === undefined
    ? null
    : { start: caret - name.length - 1, text: name };
};

/**
 * A comment box that suggests the room's models after an @. Picking one
 * writes its name into the text; the server reads the mentions from there.
 */
export const MentionInput = ({
  label,
  value,
  onChange,
  models,
  onSubmit,
  placeholder,
  autoFocus,
}: MentionInputProps) => {
  const listId = useId();
  const boxRef = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState(value.length);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const placeCaret = useRef<number | null>(null);

  const query = dismissed ? null : mentionQuery(value, caret);
  const typed = query?.text.toLowerCase() ?? "";
  let matches = query
    ? models.filter((m) => m.displayName.toLowerCase().startsWith(typed))
    : [];
  // A name typed out in full needs no suggestion, so Enter still submits.
  if (matches.length === 1 && matches[0]?.displayName.toLowerCase() === typed) {
    matches = [];
  }
  const current = Math.min(active, matches.length - 1);

  useLayoutEffect(() => {
    if (placeCaret.current === null) {
      return;
    }
    const textarea = boxRef.current?.querySelector("textarea");
    textarea?.focus();
    textarea?.setSelectionRange(placeCaret.current, placeCaret.current);
    placeCaret.current = null;
  });

  const change = (next: string, at: number) => {
    onChange(next);
    setCaret(at);
    setDismissed(false);
    setActive(0);
  };

  const pick = (model: Participant) => {
    if (!query) {
      return;
    }
    const inserted = `@${model.displayName} `;
    const next = value.slice(0, query.start) + inserted + value.slice(caret);
    placeCaret.current = query.start + inserted.length;
    change(next, placeCaret.current);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) {
      return;
    }
    if (matches.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setActive((current + step + matches.length) % matches.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const choice = matches[current];
        if (choice) {
          pick(choice);
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(true);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div ref={boxRef} className="relative">
      <Textarea
        aria-label={label}
        aria-autocomplete="list"
        aria-controls={matches.length > 0 ? listId : undefined}
        aria-activedescendant={
          matches.length > 0 ? `${listId}-${current}` : undefined
        }
        size="sm"
        rows={2}
        autoFocus={autoFocus}
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          change(
            e.target.value,
            e.target.selectionStart ?? e.target.value.length
          );
        }}
        onSelect={(e) => {
          setCaret(e.currentTarget.selectionStart ?? value.length);
        }}
        onKeyDown={onKeyDown}
      />
      {matches.length > 0 ? (
        <ul
          id={listId}
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role, jsx-a11y/no-noninteractive-element-to-interactive-role -- The ARIA combobox pattern: the textarea owns focus and points at this listbox, which a native select or datalist cannot style or place.
          role="listbox"
          aria-label="Models to mention"
          className="bg-popover text-popover-foreground absolute inset-x-0 top-full z-10 mt-1 overflow-hidden rounded-lg border py-1 text-sm shadow-md"
        >
          {matches.map((model, index) => (
            // oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- The textarea handles the keyboard (arrows, Enter, Tab); the mouse only picks.
            <li
              key={model._id}
              id={`${listId}-${index}`}
              // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role, jsx-a11y/no-noninteractive-element-to-interactive-role -- An option of the listbox above; the textarea keeps focus.
              role="option"
              aria-selected={index === current}
              className={cn(
                "cursor-pointer px-2.5 py-1",
                index === current && "bg-accent text-accent-foreground"
              )}
              // Keeps the textarea focused while choosing.
              onMouseDown={(e) => {
                e.preventDefault();
              }}
              onMouseEnter={() => {
                setActive(index);
              }}
              onClick={() => {
                pick(model);
              }}
            >
              {model.displayName}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
};
