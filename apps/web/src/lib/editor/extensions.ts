import { BLOCK_CHARS, BLOCK_KINDS } from "@atelier/shared";
import type { BlockKind } from "@atelier/shared";
import {
  Extension,
  getNodeType,
  getSchema,
  InputRule,
  mergeAttributes,
  Node,
  textblockTypeInputRule,
} from "@tiptap/core";
import type { AnyExtension, Editor } from "@tiptap/core";
import { Placeholder } from "@tiptap/extensions";
import { DOMSerializer, Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { StarterKit } from "@tiptap/starter-kit";
import { Suggestion } from "@tiptap/suggestion";
import type { SuggestionOptions } from "@tiptap/suggestion";

import { KIND_LABEL } from "~/lib/document";

import { fromDoc, kindOf, nodeName, TEXT_KINDS, toDoc } from "./codec";
import type { TextKind } from "./codec";
import { intentFor } from "./keymap";
import type { Intent, KeyContext } from "./keymap";

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

const LABEL = new Map(
  TEXT_KINDS.map((kind) => [nodeName(kind), KIND_LABEL[kind]])
);

const storedLength = (doc: ProseMirrorNode) => {
  const json: unknown = doc.toJSON();
  return typeof json === "object" && json !== null ? fromDoc(json).length : 0;
};

// Input that would take a block past its limit never lands. Shorter text
// always does, so a block can still be cut, and so does text from elsewhere.
const CharLimit = Extension.create({
  addProseMirrorPlugins: () => [
    new Plugin({
      filterTransaction: (tr, state) =>
        !tr.docChanged ||
        tr.getMeta("addToHistory") === false ||
        storedLength(tr.doc) <= Math.max(BLOCK_CHARS, storedLength(state.doc)),
    }),
  ],
  name: "charLimit",
});

/** The schema and behaviour every block editor shares. */
export const blockExtensions: AnyExtension[] = [
  BlockDocument,
  ...TEXT_KINDS.map(kindNode),
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
  CharLimit,
];

const schema = getSchema(blockExtensions);
const serializer = DOMSerializer.fromSchema(schema);

/** The block as its editor would render it, without the cost of an editor. */
export const staticContent = (kind: TextKind, text: string) =>
  serializer.serializeFragment(
    ProseMirrorNode.fromJSON(schema, toDoc(kind, text)).content
  );

/** The caret position just after a block's text in its editor. */
export const endOf = (kind: TextKind, text: string) =>
  ProseMirrorNode.fromJSON(schema, toDoc(kind, text)).content.size - 1;

/** Marks a transaction that asked for a divider, by `---` or the slash menu, instead of changing the text. */
export const DIVIDER = "blockDivider";

export const slashKey = new PluginKey<{ active: boolean }>("slashMenu");

export interface BlockKeyHandlers {
  /** The blocks around this one, as the keyboard table reads them. */
  neighbours: () => Pick<KeyContext, "previous" | "hasNext">;
  /** A key that acts on the block as a whole; `heldBy` names who stops a merge. */
  onIntent: (intent: Intent, editor: Editor, heldBy?: string) => void;
}

const KEYS = [
  "Enter",
  "Shift-Enter",
  "Mod-Enter",
  "Backspace",
  "ArrowUp",
  "ArrowDown",
] as const;

// Markdown typed at the start of a block turns it into that kind.
const SHORTCUTS: [RegExp, TextKind][] = [
  [/^#\s$/u, "heading"],
  [/^-\s$/u, "listItem"],
  [/^\d+\.\s$/u, "numberedItem"],
  [/^\[ ?\]\s$/u, "todo"],
  [/^>\s$/u, "quote"],
  [/^```$/u, "code"],
];

/** Enter, Backspace and the arrows by the keyboard table, and markdown shortcuts at the start of a block. */
export const blockKeys = (handlers: BlockKeyHandlers) =>
  Extension.create({
    addInputRules() {
      return [
        ...SHORTCUTS.map(([find, kind]) =>
          textblockTypeInputRule({
            find,
            type: getNodeType(nodeName(kind), this.editor.schema),
          })
        ),
        new InputRule({
          find: /^---$/u,
          handler: ({ state, range }) => {
            state.tr.delete(range.from, range.to).setMeta(DIVIDER, true);
          },
        }),
      ];
    },
    addKeyboardShortcuts() {
      const press = (key: KeyContext["key"]) => () => {
        const { editor } = this;
        const { state, view } = editor;
        // The slash menu takes the keys while it is open.
        if (!editor.isEditable || slashKey.getState(state)?.active === true) {
          return false;
        }
        const { doc, selection } = state;
        const end = doc.content.size - 1;
        const { intent, heldBy } = intentFor({
          ...handlers.neighbours(),
          atEnd: selection.empty && selection.to === end,
          atStart: selection.empty && selection.from === 1,
          empty: end === 1,
          // Finding the line needs layout, so only the arrows measure it.
          firstLine: key === "ArrowUp" && view.endOfTextblock("up"),
          key,
          kind: kindOf(doc.child(0).type.name),
          lastLine: key === "ArrowDown" && view.endOfTextblock("down"),
        });
        if (intent === "hardBreak") {
          return editor.commands.setHardBreak();
        }
        if (intent === "newline") {
          view.dispatch(state.tr.insertText("\n").scrollIntoView());
          return true;
        }
        if (intent === "none" && heldBy === undefined) {
          return false;
        }
        handlers.onIntent(intent, editor, heldBy);
        return true;
      };
      return Object.fromEntries(KEYS.map((key) => [key, press(key)]));
    },
    name: "blockKeys",
    // Ahead of the editor's own Enter and Backspace.
    priority: 1000,
  });

export interface SlashItem {
  kind: BlockKind;
  label: string;
  hint: string;
}

const HINT: Record<BlockKind, string> = {
  code: "Text kept exactly as written",
  divider: "A line between blocks",
  heading: "A section title",
  listItem: "A bulleted item",
  numberedItem: "An item in a numbered run",
  paragraph: "Plain text",
  quote: "Words set apart as a quote",
  todo: "An item to tick off",
};

const SLASH_ITEMS: SlashItem[] = BLOCK_KINDS.map((kind) => ({
  hint: HINT[kind],
  kind,
  label: KIND_LABEL[kind],
}));

export type SlashRender = NonNullable<
  SuggestionOptions<SlashItem, SlashItem>["render"]
>;

/** `/` opens a menu of kinds, filtered by what follows it; choosing one converts the block. */
export const slashMenu = (render: SlashRender) =>
  Extension.create({
    addProseMirrorPlugins() {
      return [
        Suggestion<SlashItem, SlashItem>({
          allow: ({ editor, state }) =>
            editor.isEditable &&
            state.selection.$from.parent.type.spec.code !== true,
          char: "/",
          command: ({ editor, range, props: item }) => {
            const chain = editor.chain().focus().deleteRange(range);
            (item.kind === "divider"
              ? chain.setMeta(DIVIDER, true)
              : chain.setNode(nodeName(item.kind))
            ).run();
          },
          editor: this.editor,
          items: ({ query }) =>
            SLASH_ITEMS.filter((item) =>
              item.label.toLowerCase().includes(query.toLowerCase())
            ),
          pluginKey: slashKey,
          render,
        }),
      ];
    },
    name: "slashMenu",
  });
