import type { BlockKind } from "@atelier/shared";
import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { fromDoc, nodeName, toDoc } from "~/lib/editor/codec";
import type { TextKind } from "~/lib/editor/codec";
import { blockExtensions, staticContent } from "~/lib/editor/extensions";

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
  autofocus: boolean;
}

const TextEditor = ({
  blockId,
  kind,
  text,
  editable,
  onChange,
  autofocus,
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

  // Keyboard focus reached the static block this editor replaced.
  useEffect(() => {
    if (autofocus) {
      editor.commands.focus("start");
    }
  }, [editor, autofocus]);

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

interface StaticBlockProps {
  blockId: string;
  kind: TextKind;
  text: string;
  onActivate?: (by: "pointer" | "focus") => void;
}

// The block as the editor would show it. Mounting hundreds of editors at once
// is too slow for a first paint, so an editor replaces this only when the
// pointer or keyboard focus reaches an editable block. Selecting text for a
// comment works here as it does in an editor.
const StaticBlock = ({ blockId, kind, text, onActivate }: StaticBlockProps) => {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    ref.current?.replaceChildren(staticContent(kind, text));
  }, [kind, text]);
  return (
    <div
      ref={ref}
      className="block-editor"
      data-block-text={blockId}
      // An editable block is a text box from the start, so Tab reaches it.
      {...(onActivate
        ? { "aria-multiline": true, role: "textbox", tabIndex: 0 }
        : {})}
      onPointerEnter={
        onActivate &&
        (() => {
          onActivate("pointer");
        })
      }
      onFocus={
        onActivate &&
        (() => {
          onActivate("focus");
        })
      }
    />
  );
};

const TextBlock = (props: TextEditorProps) => {
  const [active, setActive] = useState<"pointer" | "focus" | null>(null);
  return active === null ? (
    <StaticBlock
      {...props}
      onActivate={props.editable ? setActive : undefined}
    />
  ) : (
    <TextEditor {...props} autofocus={active === "focus"} />
  );
};

/** A block in place: its text, editable when allowed, or a rule for a divider. */
export const BlockEditor = ({ kind, ...props }: BlockEditorProps) =>
  kind === "divider" ? (
    <hr data-kind="divider" className="border-border my-3" />
  ) : (
    <TextBlock kind={kind} autofocus={false} {...props} />
  );
