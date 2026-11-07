import { StreamingMarkdown } from "~/components/markdown/StreamingMarkdown";
import { cancelReasonText, formatTime } from "~/lib/room";
import type { Names, PaneMessage } from "~/lib/room";

const DeliveryNote = ({ message }: { message: PaneMessage }) => {
  if (message.delivery === "steered") {
    return <span>Steered into the running turn</span>;
  }
  if (message.delivery === "answeredCard") {
    return <span>Answered the question card</span>;
  }
  if (message.delivery === "cancelled") {
    return (
      <span className="text-warning-foreground">
        Not delivered: {cancelReasonText(message.cancelReason)}
      </span>
    );
  }
  return null;
};

/** A person's message to an agent, or an agent reply whose turn isn't shown. */
export const MessageRow = ({
  message,
  names,
}: {
  message: PaneMessage;
  names: Names;
}) => {
  const author = names(message.authorParticipantId);
  if (message.turnId) {
    return (
      <div className="space-y-1">
        <div className="text-xs font-medium">{author}</div>
        <StreamingMarkdown text={message.body} />
      </div>
    );
  }
  return (
    <div className="bg-secondary rounded-xl px-3 py-2 text-sm">
      <div className="text-muted-foreground mb-0.5 flex flex-wrap gap-x-2 text-xs">
        <span className="text-foreground font-medium">
          {message.toParticipantId
            ? `${author} → ${names(message.toParticipantId)}`
            : author}
        </span>
        <span>{formatTime(message.at)}</span>
        <DeliveryNote message={message} />
      </div>
      <p className="[overflow-wrap:anywhere] whitespace-pre-wrap">
        {message.body}
      </p>
    </div>
  );
};
