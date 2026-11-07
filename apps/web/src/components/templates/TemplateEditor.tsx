import { PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";
import type { SyntheticEvent } from "react";

import { errorText } from "~/components/room/errors";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { hasContent, logFailure } from "~/lib/utils";

interface TemplateSection {
  heading: string;
  guidance?: string;
}

interface TemplateEditorProps {
  name: string;
  sections: readonly TemplateSection[];
  onSave: (name: string, sections: TemplateSection[]) => Promise<unknown>;
  onCancel: () => void;
}

interface DraftSection {
  key: number;
  heading: string;
  guidance: string;
}

// Keeps each draft section's key unique across editors, so React can tell them apart.
let lastKey = 0;
const newKey = () => {
  lastKey += 1;
  return lastKey;
};

const draft = (s: TemplateSection): DraftSection => ({
  guidance: s.guidance ?? "",
  heading: s.heading,
  key: newKey(),
});

/** Why the template cannot be saved yet, if it cannot. */
const blockedReason = (name: string, sections: readonly DraftSection[]) => {
  if (!name.trim()) {
    return "A template needs a name.";
  }
  return sections.some((s) => !s.heading.trim())
    ? "Every section needs a heading."
    : null;
};

/** Edits a template's name and its sections, each a heading with optional guidance below it. */
export const TemplateEditor = ({
  name: initialName,
  sections: initialSections,
  onSave,
  onCancel,
}: TemplateEditorProps) => {
  const [name, setName] = useState(initialName);
  const [sections, setSections] = useState<DraftSection[]>(() =>
    (initialSections.length > 0 ? initialSections : [{ heading: "" }]).map(
      draft
    )
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const blocked = blockedReason(name, sections);

  const change = (key: number, patch: Partial<DraftSection>) => {
    setSections((all) =>
      all.map((s) => (s.key === key ? { ...s, ...patch } : s))
    );
  };

  const submit = async (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (blocked !== null) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSave(
        name.trim(),
        sections.map((s) => {
          const heading = s.heading.trim();
          const guidance = s.guidance.trim();
          return guidance ? { guidance, heading } : { heading };
        })
      );
    } catch (error_) {
      setError(errorText(error_));
      setBusy(false);
    }
  };

  return (
    <form
      className="bg-card space-y-4 rounded-xl border p-4 text-sm"
      onSubmit={(e) => {
        submit(e).catch(logFailure);
      }}
    >
      <label className="block space-y-1.5">
        <span className="font-medium">Template name</span>
        <Input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
        />
      </label>
      <div className="space-y-3">
        {sections.map((s, index) => (
          <fieldset
            key={s.key}
            aria-label={`Section ${index + 1}`}
            className="space-y-1.5 rounded-lg border p-3"
          >
            <div className="flex items-center gap-2">
              <Input
                aria-label="Heading"
                placeholder="Heading"
                value={s.heading}
                onChange={(e) => {
                  change(s.key, { heading: e.target.value });
                }}
              />
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label="Remove section"
                onClick={() => {
                  setSections((all) => all.filter((x) => x.key !== s.key));
                }}
              >
                <XIcon />
              </Button>
            </div>
            <Textarea
              aria-label="Guidance"
              placeholder="Guidance under the heading (optional)"
              rows={2}
              value={s.guidance}
              onChange={(e) => {
                change(s.key, { guidance: e.target.value });
              }}
            />
          </fieldset>
        ))}
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          onClick={() => {
            setSections((all) => [...all, draft({ heading: "" })]);
          }}
        >
          <PlusIcon />
          Add section
        </Button>
      </div>
      {blocked === null ? null : (
        <p className="text-muted-foreground text-xs">{blocked}</p>
      )}
      {hasContent(error) ? (
        <p className="text-destructive-foreground text-xs">{error}</p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={blocked !== null || busy}>
          Save template
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
};
