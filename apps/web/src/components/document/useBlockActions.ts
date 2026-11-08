import { api } from "@atelier/backend/api";
import type { Id } from "@atelier/backend/dataModel";
import { DOCUMENT_BLOCKS } from "@atelier/shared";
import type { Editor } from "@tiptap/core";
import { useMutation } from "convex/react";

import { errorText } from "~/components/room/errors";
import type { BlockKind, DocBlock } from "~/lib/document";
import { fromDoc, sliceDoc } from "~/lib/editor/codec";
import { endOf } from "~/lib/editor/extensions";
import type { Intent } from "~/lib/editor/keymap";
import type { PastedBlock } from "~/lib/editor/paste";
import type { Session } from "~/lib/editor/session";

import type { Caret } from "./BlockEditor";

type Key = Id<"blocks">;

/** Why nothing more can be added to the document. */
export const FULL = `A document holds at most ${DOCUMENT_BLOCKS} blocks. Merge or remove some first.`;
const ADDS_A_BLOCK = new Set<Intent>([
  "insertAbove",
  "insertBelow",
  "splitParagraph",
  "splitSame",
]);

// The block's text before and after the selection.
const around = (editor: Editor) => {
  const doc = editor.getJSON();
  const { from, to } = editor.state.selection;
  return [fromDoc(sliceDoc(doc, 0, from)), fromDoc(sliceDoc(doc, to))] as const;
};

interface Options {
  roomId: Id<"rooms">;
  session: Session<Key>;
  sessionKey: Key;
  /** The block as shown, with the person's unsaved text and kind. */
  block: DocBlock;
  /** The document holds as many blocks as it can. */
  full: boolean;
  previous: DocBlock | null;
  next: DocBlock | null;
  /** Whoever else is editing the block above. */
  previousHeldBy: string | null;
  /** Puts the caret in a block. */
  onCaret: (key: Key, at: Caret) => void;
  onError: (message: string) => void;
}

/** What the person's edits to a block do: its text, its kind, its tick, and the keys that act on the block as a whole. */
export const useBlockActions = ({
  roomId,
  session,
  sessionKey,
  block,
  full,
  previous,
  next,
  previousHeldBy,
  onCaret,
  onError,
}: Options) => {
  const merge = useMutation(api.blockOps.merge);
  const setKind = useMutation(api.blockOps.setKind);
  const toggleChecked = useMutation(api.blockOps.toggleChecked);
  const insertMany = useMutation(api.blockOps.insertMany);
  const remove = useMutation(api.blocks.remove);
  const keyOf = (other: DocBlock) => session.keyOf(other._id);
  // A refusal that left a draft already says why.
  const fail = (error: unknown) => {
    if (!session.local(sessionKey).draft) {
      onError(errorText(error));
    }
  };

  // The new block shows at once; its key comes back.
  const split = (headText: string, tailKind: BlockKind, tailText: string) =>
    session.split(sessionKey, block.rev, {
      headText,
      tailKind,
      tailText,
      ...(tailKind === "todo" ? { tailChecked: false } : {}),
    });

  const splitAt = (editor: Editor | null, tailKind: BlockKind) => {
    if (!editor) {
      return;
    }
    const [headText, tailText] = around(editor);
    onCaret(split(headText, tailKind, tailText), "start");
  };

  const removeBlock = (target: DocBlock) => {
    const key = keyOf(target);
    session
      .run([[key, target.rev]], async (find) => {
        await remove({ blockId: find(key).id });
        return [[key, null]];
      })
      .catch(fail);
  };

  const changeKind = (kind: BlockKind, text: string) => {
    session
      .run(
        [[sessionKey, block.rev]],
        async (find) => {
          const { id, rev } = find(sessionKey);
          const result = await setKind({
            baseRev: rev,
            blockId: id,
            kind,
            text,
          });
          return [[sessionKey, result.rev]];
        },
        { kind, text }
      )
      .catch(fail);
    if (kind === "divider") {
      onCaret(sessionKey, "start");
    }
  };

  const mergeInto = async (into: DocBlock) => {
    if (into.kind === "divider") {
      return;
    }
    const intoKey = keyOf(into);
    // Where the two texts meet, after the new line that joins code.
    const join =
      endOf(into.kind, session.local(intoKey).text ?? into.text) +
      (into.kind === "code" ? 1 : 0);
    await session.run(
      [
        [sessionKey, block.rev],
        [intoKey, into.rev],
      ],
      async (find) => {
        const merged = find(sessionKey);
        const result = await merge({
          baseRev: merged.rev,
          blockId: merged.id,
          previousBaseRev: find(intoKey).rev,
        });
        return [
          [sessionKey, null],
          [intoKey, result.rev],
        ];
      }
    );
    onCaret(intoKey, join);
  };

  const insertAbove = () => {
    const after = previous && keyOf(previous);
    session
      .run(previous && after ? [[after, previous.rev]] : [], async (find) => {
        const inserted = await insertMany({
          afterBlockId: after === null ? null : find(after).id,
          blocks: [{ kind: block.kind, text: "" }],
          roomId,
        });
        // The caret stays here, so the lease the new block came with goes back.
        for (const { blockId } of inserted.blocks) {
          session.leased(blockId);
          session.blur(blockId);
        }
        return [];
      })
      .catch(fail);
  };

  // The caret keeps its place across the line where it can.
  const focusOn = (
    to: DocBlock | null,
    line: "first" | "last",
    editor: Editor | null
  ) => {
    if (!to) {
      return;
    }
    let at: Caret = line === "first" ? "start" : "end";
    if (editor) {
      const { left } = editor.view.coordsAtPos(editor.state.selection.head);
      at = { line, x: left };
    }
    onCaret(keyOf(to), at);
  };

  const intent = (what: Intent, editor: Editor | null, heldBy?: string) => {
    if (heldBy !== undefined) {
      onError(`${heldBy} is editing the block above`);
      return;
    }
    if (full && ADDS_A_BLOCK.has(what)) {
      onError(FULL);
      return;
    }
    const act: Partial<Record<Intent, () => void>> = {
      convertToParagraph: () => {
        editor?.commands.setNode("paragraph");
      },
      focusNext: () => {
        focusOn(next, "first", editor);
      },
      focusPrevious: () => {
        focusOn(previous, "last", editor);
      },
      insertAbove,
      insertBelow: () => {
        onCaret(split(block.text, "paragraph", ""), "start");
      },
      mergeIntoPrevious: () => {
        if (previous) {
          mergeInto(previous).catch(fail);
        }
      },
      removePrevious: () => {
        if (previous) {
          removeBlock(previous);
        }
      },
      removeSelf: () => {
        const to = next ?? previous;
        if (to) {
          onCaret(keyOf(to), next ? "start" : "end");
        }
        removeBlock(block);
      },
      splitParagraph: () => {
        splitAt(editor, "paragraph");
      },
      splitSame: () => {
        splitAt(editor, block.kind);
      },
    };
    act[what]?.();
  };

  return {
    fail,
    handleChange: (text: string) => {
      session.change(sessionKey, text, block.rev);
    },
    /** A divider asked for in the block: it becomes one when empty, or one goes below it. */
    handleDivider: (text: string) => {
      if (text === "") {
        changeKind("divider", "");
        return;
      }
      if (full) {
        onError(FULL);
        return;
      }
      // The person types on here, so the lease the divider came with goes back.
      session.blur(split(text, "divider", ""));
    },
    handleKind: changeKind,
    /**
     * Pasted text that makes several blocks: they go in after this block, which
     * keeps the text before the caret, and the last takes the text after it,
     * all in one write. A refusal keeps the block with the paste as a draft.
     */
    handlePaste: (
      rows: readonly PastedBlock[],
      pasted: string,
      editor: Editor
    ) => {
      const [headText, tailText] = around(editor);
      session
        .run(
          [[sessionKey, block.rev]],
          async (find) => {
            const { id, rev } = find(sessionKey);
            const inserted = await insertMany({
              afterBlockId: id,
              blocks: [...rows],
              roomId,
              source: { baseRev: rev, headText, tailText },
            });
            const revs: [Key, number][] = [[sessionKey, inserted.rev ?? rev]];
            const last = inserted.blocks.at(-1);
            const lastRow = rows.at(-1);
            if (last && lastRow) {
              session.leased(last.blockId);
              revs.push([last.blockId, last.rev]);
              // The caret goes where the pasted text ends.
              onCaret(
                last.blockId,
                lastRow.kind === "divider"
                  ? "start"
                  : endOf(lastRow.kind, lastRow.text)
              );
            }
            return revs;
          },
          { text: headText + pasted + tailText }
        )
        .catch(fail);
    },
    handleToggle: (checked: boolean) => {
      session
        .run(
          [[sessionKey, block.rev]],
          async (find) => {
            const { id, rev } = find(sessionKey);
            const result = await toggleChecked({
              baseRev: rev,
              blockId: id,
              checked,
            });
            return [[sessionKey, result.rev]];
          },
          { checked }
        )
        .catch(fail);
    },
    intent,
    keys: {
      neighbours: () => ({
        hasNext: next !== null,
        previous: previous && { heldBy: previousHeldBy, kind: previous.kind },
      }),
      onIntent: intent,
    },
  };
};
