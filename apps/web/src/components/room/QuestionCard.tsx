import { api } from "@atelier/backend/api";
import type { Id } from "@atelier/backend/dataModel";
import { useMutation } from "convex/react";
import { CheckIcon, MessageCircleQuestionIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import {
  buildCardAnswers,
  describeCardAnswer,
  toPendingQuestion,
} from "~/lib/cardAnswers";
import type { CardDrafts } from "~/lib/cardAnswers";
import {
  isPendingUserInputOptionSelected,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
} from "~/lib/pendingUserInput";
import type { Names, PaneCard } from "~/lib/room";

import { errorText } from "./errors";

interface QuestionCardProps {
  roomId: Id<"rooms">;
  card: PaneCard;
  agentName: string;
  names: Names;
  offline: boolean;
}

/** An agent's question card: answerable while open, then a record of how it closed. */
export function QuestionCard(props: QuestionCardProps) {
  return props.card.status === "raised" ? (
    <OpenCard {...props} />
  ) : (
    <ClosedCard {...props} />
  );
}

function OpenCard({ card, agentName, offline }: QuestionCardProps) {
  const answer = useMutation(api.hands.answer);
  const [drafts, setDrafts] = useState<CardDrafts>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answers = buildCardAnswers(card.questions, drafts);

  const submit = async () => {
    if (!answers) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await answer({ answers, handId: card.id });
    } catch (error_) {
      setError(errorText(error_));
    }
    setBusy(false);
  };

  return (
    <div
      role="group"
      aria-label={`${agentName} asks`}
      className="border-info/40 bg-info/4 rounded-xl border p-3 text-sm shadow-xs/5"
    >
      <div className="text-info-foreground mb-2 flex items-center gap-1.5 text-xs font-medium">
        <MessageCircleQuestionIcon className="size-3.5" />
        {agentName} asks
      </div>
      <div className="space-y-4">
        {card.questions.map((question) => {
          const pending = toPendingQuestion(question);
          const draft = drafts[question.id];
          return (
            <fieldset key={question.id} className="space-y-2">
              <legend className="mb-1">
                {question.header ? (
                  <span className="text-2xs text-muted-foreground block font-semibold tracking-wide uppercase">
                    {question.header}
                  </span>
                ) : null}
                <span className="font-medium">{question.text}</span>
                {question.multiSelect ? (
                  <span className="text-muted-foreground ml-1 text-xs">
                    (choose any)
                  </span>
                ) : null}
              </legend>
              <div className="flex flex-col gap-1.5">
                {question.options.map((option) => {
                  const selected = isPendingUserInputOptionSelected(
                    pending,
                    draft,
                    option.label
                  );
                  return (
                    <button
                      key={option.label}
                      type="button"
                      aria-pressed={selected}
                      disabled={busy}
                      onClick={() => {
                        setDrafts((d) => ({
                          ...d,
                          [question.id]: togglePendingUserInputOptionSelection(
                            pending,
                            d[question.id],
                            option.label
                          ),
                        }));
                      }}
                      className="bg-background hover:bg-accent aria-pressed:border-primary aria-pressed:bg-primary/6 flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-left"
                    >
                      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border">
                        {selected ? <CheckIcon className="size-3" /> : null}
                      </span>
                      <span>
                        <span className="font-medium">{option.label}</span>
                        {option.description ? (
                          <span className="text-muted-foreground block text-xs">
                            {option.description}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  );
                })}
              </div>
              {question.allowFreeText ? (
                <Textarea
                  size="sm"
                  rows={1}
                  aria-label={`Your own answer to: ${question.text}`}
                  placeholder="Or write your own answer"
                  value={draft?.customAnswer ?? ""}
                  disabled={busy}
                  onChange={(e) => {
                    setDrafts((d) => ({
                      ...d,
                      [question.id]: setPendingUserInputCustomAnswer(
                        pending,
                        d[question.id],
                        e.target.value
                      ),
                    }));
                  }}
                />
              ) : null}
            </fieldset>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={!answers || busy || offline}
          onClick={() => void submit()}
        >
          Answer
        </Button>
        <span className="text-muted-foreground text-xs">
          The first answer counts. A message to {agentName} also answers this
          card.
        </span>
      </div>
      {error ? (
        <p className="text-destructive-foreground mt-2 text-xs">{error}</p>
      ) : null}
    </div>
  );
}

function ClosedCard({
  roomId,
  card,
  agentName,
  names,
  offline,
}: QuestionCardProps) {
  const answers = card.answers ?? [];
  const answerFor = (questionId: string) =>
    answers.find((a) => a.questionId === questionId);

  return (
    <div className="bg-card/60 rounded-xl border p-3 text-sm">
      <div className="text-muted-foreground mb-1.5 text-xs font-medium">
        {card.status === "answered" ? (
          card.via === "chat" ? (
            <span>
              Answered in chat by {names(card.answeredByParticipantId)}
            </span>
          ) : (
            <span>Answered by {names(card.answeredByParticipantId)}</span>
          )
        ) : card.status === "cancelled" ? (
          <span>Cancelled: the turn was stopped before anyone answered</span>
        ) : (
          <span>Expired with no decision</span>
        )}
        {card.status !== "answered" && card.closeReason ? (
          <span className="font-normal"> ({card.closeReason})</span>
        ) : null}
      </div>
      <ul className="space-y-1.5">
        {card.questions.map((question) => {
          const answer = answerFor(question.id);
          return (
            <li key={question.id}>
              <span className="text-muted-foreground">{question.text}</span>
              {answer ? (
                <span className="block font-medium">
                  {describeCardAnswer(answer)}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
      {card.status === "expired" ? (
        <LateAnswer
          roomId={roomId}
          agentId={card.participantId}
          agentName={agentName}
          offline={offline}
        />
      ) : null}
    </div>
  );
}

function LateAnswer({
  roomId,
  agentId,
  agentName,
  offline,
}: {
  roomId: Id<"rooms">;
  agentId: Id<"participants">;
  agentName: string;
  offline: boolean;
}) {
  const send = useMutation(api.messages.send);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <Button
        className="mt-2"
        size="xs"
        variant="outline"
        onClick={() => {
          setOpen(true);
        }}
      >
        Send a late answer as a message
      </Button>
    );
  }

  const submit = async () => {
    const body = text.trim();
    if (!body) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await send({ body, roomId, toParticipantId: agentId });
      setText("");
      setOpen(false);
    } catch (error_) {
      setError(errorText(error_));
    }
    setBusy(false);
  };

  return (
    <div className="mt-2 space-y-2">
      <Textarea
        size="sm"
        rows={2}
        aria-label={`Late answer to ${agentName}`}
        placeholder={`Your answer goes to ${agentName} as a message`}
        value={text}
        disabled={busy}
        onChange={(e) => {
          setText(e.target.value);
        }}
      />
      <div className="flex gap-2">
        <Button
          size="xs"
          disabled={!text.trim() || busy || offline}
          onClick={() => void submit()}
        >
          Send late answer
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            setOpen(false);
          }}
        >
          Cancel
        </Button>
      </div>
      {error ? (
        <p className="text-destructive-foreground text-xs">{error}</p>
      ) : null}
    </div>
  );
}
