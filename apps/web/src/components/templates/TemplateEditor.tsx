import { PlusIcon, XIcon } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { errorText } from '~/components/room/errors';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Textarea } from '~/components/ui/textarea';

export interface TemplateSection {
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

/** Edits a template's name and its sections, each a heading with optional guidance below it. */
export function TemplateEditor({ name: initialName, sections: initialSections, onSave, onCancel }: TemplateEditorProps) {
  const nextKey = useRef(0);
  const draft = (s: TemplateSection): DraftSection => ({ key: nextKey.current++, heading: s.heading, guidance: s.guidance ?? '' });
  const [name, setName] = useState(initialName);
  const [sections, setSections] = useState<DraftSection[]>(() =>
    (initialSections.length > 0 ? initialSections : [{ heading: '' }]).map(draft),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const blocked = !name.trim()
    ? 'A template needs a name.'
    : sections.some((s) => !s.heading.trim())
      ? 'Every section needs a heading.'
      : null;

  const change = (key: number, patch: Partial<DraftSection>) =>
    setSections((all) => all.map((s) => (s.key === key ? { ...s, ...patch } : s)));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (blocked) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(
        name.trim(),
        sections.map((s) => {
          const heading = s.heading.trim();
          const guidance = s.guidance.trim();
          return guidance ? { heading, guidance } : { heading };
        }),
      );
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <form className="space-y-4 rounded-xl border bg-card p-4 text-sm" onSubmit={(e) => void submit(e)}>
      <label className="block space-y-1.5">
        <span className="font-medium">Template name</span>
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="space-y-3">
        {sections.map((s, index) => (
          <fieldset key={s.key} aria-label={`Section ${index + 1}`} className="space-y-1.5 rounded-lg border p-3">
            <div className="flex items-center gap-2">
              <Input aria-label="Heading" placeholder="Heading" value={s.heading} onChange={(e) => change(s.key, { heading: e.target.value })} />
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label="Remove section"
                onClick={() => setSections((all) => all.filter((x) => x.key !== s.key))}
              >
                <XIcon />
              </Button>
            </div>
            <Textarea
              aria-label="Guidance"
              placeholder="Guidance under the heading (optional)"
              rows={2}
              value={s.guidance}
              onChange={(e) => change(s.key, { guidance: e.target.value })}
            />
          </fieldset>
        ))}
        <Button type="button" size="xs" variant="ghost-muted" onClick={() => setSections((all) => [...all, draft({ heading: '' })])}>
          <PlusIcon />
          Add section
        </Button>
      </div>
      {blocked ? <p className="text-xs text-muted-foreground">{blocked}</p> : null}
      {error ? <p className="text-xs text-destructive-foreground">{error}</p> : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!!blocked || busy}>
          Save template
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
