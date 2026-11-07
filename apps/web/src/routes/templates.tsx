import { api } from "@atelier/backend/api";
import type { Id } from "@atelier/backend/dataModel";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { OwnerOnly, PageSpinner, SignedInOnly } from "~/components/page";
import { errorText } from "~/components/room/errors";
import { TemplateEditor } from "~/components/templates/TemplateEditor";
import { Button } from "~/components/ui/button";
import {
  StandalonePage,
  StandalonePageHeader,
} from "~/components/ui/standalone-page";
import { hasContent } from "~/lib/utils";

const EditTemplate = ({
  template,
  onDone,
}: {
  template: Template;
  onDone: () => void;
}) => {
  const update = useMutation(api.templates.update);
  return (
    <TemplateEditor
      name={template.name}
      sections={template.sections}
      onSave={async (name, sections) => {
        await update({ name, sections, templateId: template._id });
        onDone();
      }}
      onCancel={onDone}
    />
  );
};

const TemplateRow = ({
  template,
  onEdit,
}: {
  template: Template;
  onEdit: () => void;
}) => {
  const remove = useMutation(api.templates.remove);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <li className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm">
      <div className="min-w-0 flex-1">
        <div className="font-medium">{template.name}</div>
        <div className="text-muted-foreground text-xs">
          {template.sections.map((s) => s.heading).join(" · ")}
        </div>
        {confirming ? (
          <div className="text-xs">
            Rooms already made from it keep their documents.
          </div>
        ) : null}
        {hasContent(error) ? (
          <div className="text-destructive-foreground text-xs">{error}</div>
        ) : null}
      </div>
      {confirming ? (
        <>
          <Button
            size="xs"
            variant="destructive"
            onClick={() => {
              remove({ templateId: template._id }).catch((error_: unknown) => {
                setError(errorText(error_));
              });
            }}
          >
            Delete
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              setConfirming(false);
            }}
          >
            Keep
          </Button>
        </>
      ) : (
        <>
          <Button
            size="xs"
            variant="outline"
            aria-label={`Edit ${template.name}`}
            onClick={onEdit}
          >
            Edit
          </Button>
          <Button
            size="xs"
            variant="ghost"
            aria-label={`Delete ${template.name}`}
            onClick={() => {
              setConfirming(true);
            }}
          >
            Delete
          </Button>
        </>
      )}
    </li>
  );
};

const Templates = () => {
  const templates = useQuery(api.templates.list, {});
  const create = useMutation(api.templates.create);
  // The template being edited, or 'new' while writing one.
  const [editing, setEditing] = useState<Id<"templates"> | "new" | null>(null);

  return (
    <StandalonePage align="top">
      <StandalonePageHeader
        context={
          <Link to="/" className="hover:text-foreground">
            Your rooms
          </Link>
        }
        title="Templates"
        description="A new room's document starts with its template's headings and guidance. Rooms created without one use Atelier's default."
      />
      <div className="mt-6 space-y-3">
        {templates === undefined ? (
          <PageSpinner />
        ) : (
          <>
            {templates.length === 0 && editing !== "new" ? (
              <p className="text-muted-foreground text-sm">No templates yet.</p>
            ) : null}
            {templates.length > 0 ? (
              <ul className="bg-card divide-y rounded-xl border">
                {templates.map((t) =>
                  editing === t._id ? (
                    <li key={t._id} className="p-2">
                      <EditTemplate
                        template={t}
                        onDone={() => {
                          setEditing(null);
                        }}
                      />
                    </li>
                  ) : (
                    <TemplateRow
                      key={t._id}
                      template={t}
                      onEdit={() => {
                        setEditing(t._id);
                      }}
                    />
                  )
                )}
              </ul>
            ) : null}
            {editing === "new" ? (
              <TemplateEditor
                name=""
                sections={[]}
                onSave={async (name, sections) => {
                  await create({ name, sections });
                  setEditing(null);
                }}
                onCancel={() => {
                  setEditing(null);
                }}
              />
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setEditing("new");
                }}
              >
                <PlusIcon />
                New template
              </Button>
            )}
          </>
        )}
      </div>
    </StandalonePage>
  );
};

export const Route = createFileRoute("/templates")({
  component: () => (
    <SignedInOnly>
      <OwnerOnly title="Only Robert can write templates">
        <Templates />
      </OwnerOnly>
    </SignedInOnly>
  ),
});

type Template = FunctionReturnType<typeof api.templates.list>[number];
