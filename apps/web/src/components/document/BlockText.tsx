import { StreamingMarkdown } from "~/components/markdown/StreamingMarkdown";
import { KIND_LABEL } from "~/lib/document";
import type { BlockKind } from "~/lib/document";

/** A block's text as readers see it. */
export const BlockText = ({
  kind,
  text,
}: {
  kind: BlockKind;
  text: string;
}) => {
  if (!text.trim()) {
    return (
      <p className="text-muted-foreground text-sm italic">
        Empty {KIND_LABEL[kind].toLowerCase()}
      </p>
    );
  }
  if (kind === "heading") {
    return (
      <h3 className="text-base font-semibold tracking-tight [overflow-wrap:anywhere]">
        {text}
      </h3>
    );
  }
  return (
    <StreamingMarkdown
      className="block-text"
      text={kind === "listItem" ? `- ${text}` : text}
    />
  );
};
