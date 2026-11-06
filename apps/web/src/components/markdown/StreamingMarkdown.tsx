import { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PluggableList } from "unified";

import { createIncrementalMarkdownPlugin } from "~/lib/markdown-incremental";
import { splitMarkdownBlocks } from "~/lib/markdownStreamBlocks";
import { cn } from "~/lib/utils";

const PLUGINS: PluggableList = [remarkGfm];
const OPENS_FENCE = /(?:^|\n) {0,3}(?:`{3}|~{3})/u;

const components: Components = {
  a: ({ node: _node, children, ...props }) => (
    <a {...props} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
};

const MarkdownBlockContent = ({
  text,
  plugins,
}: {
  text: string;
  plugins: PluggableList;
}) => (
  <ReactMarkdown remarkPlugins={plugins} components={components}>
    {text}
  </ReactMarkdown>
);

const MarkdownBlock = memo(MarkdownBlockContent);

/**
 * Markdown that may still be streaming. While it streams, finished blocks
 * are rendered once and only the last block re-renders as text arrives.
 * Text whose syntax ties blocks together is parsed whole, reusing the parse
 * of any closed code fences.
 */
export const StreamingMarkdown = ({
  text,
  streaming = false,
  className,
}: {
  text: string;
  streaming?: boolean;
  className?: string;
}) => {
  // One incremental parser per streaming renderer; it caches this text's prefix.
  // oxlint-disable-next-line react/hook-use-state -- The plugin list is created once and never replaced, so there is no setter to keep.
  const [incremental] = useState<PluggableList>(() => [
    remarkGfm,
    createIncrementalMarkdownPlugin(),
  ]);
  const blocks = streaming ? splitMarkdownBlocks(text) : null;
  const plugins =
    streaming && blocks === null && OPENS_FENCE.test(text)
      ? incremental
      : PLUGINS;

  return (
    <div
      className={cn(
        "chat-markdown w-full min-w-0 text-sm leading-relaxed [overflow-wrap:anywhere]",
        className
      )}
      data-streaming={streaming ? "" : undefined}
    >
      {(blocks ?? [text]).map((block, index) => (
        // Streamed blocks only ever change at the end, so the index is a stable key.
        <MarkdownBlock key={index} text={block} plugins={plugins} />
      ))}
    </div>
  );
};
