import type { BlockKind } from "@atelier/shared";
import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect } from "react";

import { fromDoc, nodeName, toDoc } from "~/lib/editor/codec";
import type { TextKind } from "~/lib/editor/codec";
import { blockExtensions } from "~/lib/editor/extensions";

interface BlockEditorProps {
  blockId: string;
  kind: BlockKind;
  text: string;
  editable: boolean;
  /** The block's new text, after the person changed its content. */
  onChange?: (text: string) => void;
}

interface TextEditorProps extends BlockEditorProps {
  kind: TextKind;
}

const TextEditor = ({
  blockId,
  kind,
  text,
  editable,
  onChange,
}: TextEditorProps) => {
  // Created once per block; later kind, text and editable changes are applied below.
  const editor = useEditor(
    {
      content: toDoc(kind, text),
      editable,
      editorProps: {
        // Comments map a selection in here back to the stored text.
        attributes: { class: "block-editor", "data-block-text": blockId },
      },
      extensions: blockExtensions,
      // Only transactions that change the document land here, so mounting,
      // focusing and blurring never write.
      onUpdate: ({ editor: changed }) => {
        onChange?.(fromDoc(changed.getJSON()));
      },
    },
    []
  );

  useEffect(() => {
    editor.setEditable(editable, false);
  }, [editor, editable]);

  // A change from elsewhere replaces the one node in place, kind included,
  // without remounting. It is not the person's edit: it writes nothing back
  // and undo cannot bring the old text back.
  useEffect(() => {
    const doc = editor.getJSON();
    if (doc.content?.[0]?.type === nodeName(kind) && fromDoc(doc) === text) {
      return;
    }
    editor
      .chain()
      .setMeta("addToHistory", false)
      .setContent(toDoc(kind, text), { emitUpdate: false })
      .run();
  }, [editor, kind, text]);

  return <EditorContent editor={editor} />;
};

/** A block in place: a rich-text editor over its kind and text, or a rule for a divider. */
export const BlockEditor = ({ kind, ...props }: BlockEditorProps) =>
  kind === "divider" ? (
    <hr data-kind="divider" className="border-border my-3" />
  ) : (
    <TextEditor kind={kind} {...props} />
  );
