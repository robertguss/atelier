import type { BlockKind } from "@atelier/shared";
import type { Editor } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import { EditorContent, useEditor } from "@tiptap/react";
import { exitSuggestion } from "@tiptap/suggestion";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { fromDoc, kindOf, nodeName, toDoc } from "~/lib/editor/codec";
import type { TextKind } from "~/lib/editor/codec";
import {
  blockExtensions,
  blockKeys,
  DIVIDER,
  slashKey,
  slashMenu,
  staticContent,
} from "~/lib/editor/extensions";
import type { BlockKeyHandlers } from "~/lib/editor/extensions";
import { pastedBlocks } from "~/lib/editor/paste";
import type { PastedBlock } from "~/lib/editor/paste";

import { optionId, SlashMenu, useSlashMenu } from "./SlashMenu";

/** Where the caret goes: a position, the start or end, or a point on the first or last line. */
export type Caret =
  | "start"
  | "end"
  | number
  | { x: number; line: "first" | "last" };

interface BlockEditorProps {
  blockId: string;
  kind: BlockKind;
  text: string;
  editable: boolean;
  /** The block's new text, after the person changed its content. */
  onChange?: (text: string) => void;
  /** The person turned the block into another kind; `text` is its text as that kind. */
  onKind?: (kind: BlockKind, text: string) => void;
  /** The person asked for a divider here; `text` is the block's text without what asked. */
  onDivider?: (text: string) => void;
  /** The person pasted text that makes several blocks; `text` is the text as pasted. */
  onPaste?: (
    rows: readonly PastedBlock[],
    text: string,
    editor: Editor
  ) => void;
  /** Keys that act on the block as a whole. */
  keys?: BlockKeyHandlers;
  /** Puts the caret in the block; each request is a new object. */
  caret?: { at: Caret };
}

interface TextEditorProps extends BlockEditorProps {
  kind: TextKind;
  /** Keyboard focus reached the static block this editor replaced. */
  autoFocus: boolean;
}

// A fresh state with the same document and selection has no undo history.
const clearHistory = (editor: Editor) => {
  const { doc, plugins, selection } = editor.state;
  editor.view.updateState(EditorState.create({ doc, plugins, selection }));
};

const caretAt = (editor: Editor, at: Caret) => {
  if (typeof at !== "object") {
    return at;
  }
  const box = editor.view.dom.getBoundingClientRect();
  const found = editor.view.posAtCoords({
    left: at.x,
    top: at.line === "first" ? box.top + 1 : box.bottom - 1,
  });
  return found?.pos ?? (at.line === "first" ? "start" : "end");
};

// The editor is made once, so its key handlers reach the latest ones through this.
const useKeys = (keys: BlockKeyHandlers | undefined): BlockKeyHandlers => {
  const latest = useRef(keys);
  useLayoutEffect(() => {
    latest.current = keys;
  });
  return {
    neighbours: () =>
      latest.current?.neighbours() ?? { hasNext: false, previous: null },
    onIntent: (intent, editor, heldBy) => {
      latest.current?.onIntent(intent, editor, heldBy);
    },
  };
};

const TextEditor = (props: TextEditorProps) => {
  const { blockId, kind, text, editable, caret, autoFocus } = props;
  // The editor is created once, so it reaches the latest props through this.
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  const keys = useKeys(props.keys);
  const slash = useSlashMenu();
  const menuId = useId();
  const highlighted = slash.menu?.items[slash.menu.active];
  // Created once per block; later kind, text and editable changes are applied below.
  const editor = useEditor(
    {
      content: toDoc(kind, text),
      editable,
      editorProps: {
        // Comments map a selection in here back to the stored text. These
        // are applied again on every render, so they follow a split's new
        // block to its real id.
        attributes: {
          class: "block-editor",
          "data-block-text": blockId,
          ...(highlighted
            ? { "aria-activedescendant": optionId(menuId, highlighted) }
            : {}),
        },
        // Text in several parts becomes several blocks; one part is an
        // ordinary edit, and code keeps its blank lines.
        handlePaste: (_view, event) => {
          const { kind: shownKind, onPaste } = latest.current;
          const pasted = event.clipboardData?.getData("text/plain") ?? "";
          const rows = pastedBlocks(pasted);
          if (!onPaste || shownKind === "code" || rows.length < 2) {
            return false;
          }
          onPaste(rows, pasted, editor);
          return true;
        },
      },
      extensions: [
        ...blockExtensions,
        blockKeys(keys),
        slashMenu(slash.render),
      ],
      // Only transactions that change the document land here, so mounting,
      // focusing and blurring never write.
      onUpdate: ({ editor: changed, transaction }) => {
        const { onChange, onKind, onDivider } = latest.current;
        const doc = changed.getJSON();
        const changedText = fromDoc(doc);
        const changedKind = kindOf(doc.content?.[0]?.type ?? "");
        if (transaction.getMeta(DIVIDER) === true) {
          onDivider?.(changedText);
        } else if (changedKind === latest.current.kind) {
          onChange?.(changedText);
        } else {
          onKind?.(changedKind, changedText);
        }
      },
    },
    []
  );

  useEffect(() => {
    editor.setEditable(editable, false);
  }, [editor, editable]);

  useEffect(() => {
    if (autoFocus) {
      editor.commands.focus("start");
    }
  }, [editor, autoFocus]);

  useEffect(() => {
    if (caret) {
      editor.commands.focus(caretAt(editor, caret.at));
    }
  }, [editor, caret]);

  // A change from elsewhere replaces the one node in place, kind included,
  // without remounting. It is not the person's edit: it writes nothing back,
  // and undo cannot reach past it, so undo never brings back text that a
  // split or merge moved to another block. It runs before the browser takes
  // the next keystroke, so it never compares against stale text.
  useLayoutEffect(() => {
    const doc = editor.getJSON();
    if (doc.content?.[0]?.type === nodeName(kind) && fromDoc(doc) === text) {
      return;
    }
    editor
      .chain()
      .setMeta("addToHistory", false)
      .setContent(toDoc(kind, text), { emitUpdate: false })
      .run();
    clearHistory(editor);
  }, [editor, kind, text]);

  return (
    <>
      <EditorContent editor={editor} />
      {slash.menu ? (
        <SlashMenu
          id={menuId}
          menu={slash.menu}
          onClose={() => {
            exitSuggestion(editor.view, slashKey);
          }}
        />
      ) : null}
    </>
  );
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

const TextBlock = (props: Omit<TextEditorProps, "autoFocus">) => {
  const [reached, setReached] = useState<"pointer" | "focus" | "caret" | null>(
    null
  );
  // A caret sent here mounts the editor for good.
  if (reached === null && props.caret && props.editable) {
    setReached("caret");
  }
  return reached === null ? (
    <StaticBlock
      {...props}
      onActivate={props.editable ? setReached : undefined}
    />
  ) : (
    <TextEditor {...props} autoFocus={reached === "focus"} />
  );
};

/** What stands before a block's text, outside it: a to-do's box, a bullet or a number. */
export const KindMarker = ({
  kind,
  checked,
  number,
  label,
  onToggle,
}: {
  kind: BlockKind;
  checked: boolean;
  number: number | undefined;
  label: string;
  /** Ticks the to-do; without it the box only shows the tick. */
  onToggle?: (checked: boolean) => void;
}) => {
  if (kind === "todo") {
    return (
      <input
        type="checkbox"
        checked={checked}
        disabled={!onToggle}
        readOnly={!onToggle}
        onChange={(e) => {
          onToggle?.(e.target.checked);
        }}
        aria-label={label || "To-do"}
        className="accent-primary translate-y-0.5"
      />
    );
  }
  if (kind === "listItem") {
    return <span className="text-muted-foreground">•</span>;
  }
  return number === undefined ? null : (
    <span className="text-muted-foreground tabular-nums">{number}.</span>
  );
};

/** A block in place: its text, editable when allowed, or a rule for a divider. */
export const BlockEditor = ({ kind, ...props }: BlockEditorProps) =>
  kind === "divider" ? (
    <hr data-kind="divider" className="border-border my-3" />
  ) : (
    <TextBlock kind={kind} {...props} />
  );
