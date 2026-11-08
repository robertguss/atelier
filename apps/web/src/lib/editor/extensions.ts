import { BLOCK_KINDS } from "@atelier/shared";
import { mergeAttributes, Node } from "@tiptap/core";
import type { AnyExtension } from "@tiptap/core";
import { Placeholder } from "@tiptap/extensions";
import { StarterKit } from "@tiptap/starter-kit";

import { KIND_LABEL } from "~/lib/document";

import { nodeName } from "./codec";
import type { TextKind } from "./codec";

// A block's editor holds exactly one node, whose type is the block's kind.
const BlockDocument = Node.create({
  content: "block",
  name: "doc",
  topNode: true,
});

const TAG: Record<TextKind, string> = {
  code: "pre",
  heading: "h3",
  listItem: "p",
  numberedItem: "p",
  paragraph: "p",
  quote: "blockquote",
  todo: "p",
};

// Flat nodes, no list wrappers: a list item is one row like any other.
const kindNode = (kind: TextKind) =>
  Node.create({
    group: "block",
    name: nodeName(kind),
    // Plain-text paste arrives as paragraphs; it lands in whatever kind this is.
    parseHTML: () => (kind === "paragraph" ? [{ tag: "p" }] : []),
    renderHTML: ({ HTMLAttributes }) => [
      TAG[kind],
      mergeAttributes(HTMLAttributes, { "data-kind": kind }),
      0,
    ],
    ...(kind === "code"
      ? { code: true, content: "text*", marks: "" }
      : { content: "inline*" }),
  });

const KINDS = BLOCK_KINDS.filter((kind) => kind !== "divider");
const LABEL = new Map(KINDS.map((kind) => [nodeName(kind), KIND_LABEL[kind]]));

/** The schema and behaviour every block editor shares. */
export const blockExtensions: AnyExtension[] = [
  BlockDocument,
  ...KINDS.map(kindNode),
  StarterKit.configure({
    blockquote: false,
    bulletList: false,
    codeBlock: false,
    document: false,
    dropcursor: false,
    gapcursor: false,
    heading: false,
    horizontalRule: false,
    listItem: false,
    listKeymap: false,
    orderedList: false,
    paragraph: false,
    trailingNode: false,
    // No markdown form, so it could not be stored.
    underline: false,
  }),
  Placeholder.configure({
    placeholder: ({ node }) => LABEL.get(node.type.name) ?? "",
  }),
];
