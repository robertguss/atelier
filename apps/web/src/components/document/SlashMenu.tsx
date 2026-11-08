import { useRef, useState } from "react";

import { AnchoredPopover } from "~/components/ui/popover";
import type { SlashItem, SlashRender } from "~/lib/editor/extensions";
import { cn } from "~/lib/utils";

interface SlashMenuState {
  items: SlashItem[];
  /** The highlighted item. */
  active: number;
  choose: (item: SlashItem) => void;
  rect: (() => DOMRect | null) | null | undefined;
}

const STEP: Record<string, number> = { ArrowDown: 1, ArrowUp: -1 };

/** The menu's state, and the renderer that feeds it from the editor's `/` suggestion and its keys. */
export const useSlashMenu = () => {
  const [menu, setMenu] = useState<SlashMenuState | null>(null);
  // The keys read the menu between renders.
  const current = useRef(menu);
  const show = (next: SlashMenuState | null) => {
    current.current = next;
    setMenu(next);
  };
  const open = ({
    items,
    command,
    clientRect,
  }: Parameters<NonNullable<ReturnType<SlashRender>["onStart"]>>[0]) => {
    show({ active: 0, choose: command, items, rect: clientRect });
  };
  const render: SlashRender = () => ({
    onExit: () => {
      show(null);
    },
    onKeyDown: ({ event }) => {
      const shown = current.current;
      if (!shown) {
        return false;
      }
      const count = shown.items.length;
      if (event.key === "Enter") {
        // With no match, Enter adds nothing.
        const item = shown.items[shown.active];
        if (item) {
          shown.choose(item);
        }
        return true;
      }
      const step = STEP[event.key] ?? 0;
      if (step === 0 || count === 0) {
        return false;
      }
      show({ ...shown, active: (shown.active + step + count) % count });
      return true;
    },
    onStart: open,
    onUpdate: open,
  });
  return { menu, render };
};

export const optionId = (menuId: string, item: SlashItem) =>
  `${menuId}-${item.kind}`;

/** The kinds a block can become, as a listbox the caret in the block drives. */
export const SlashMenu = ({
  id,
  menu,
  onClose,
}: {
  id: string;
  menu: SlashMenuState;
  onClose: () => void;
}) => (
  <AnchoredPopover
    anchor={() => ({
      getBoundingClientRect: () => menu.rect?.() ?? new DOMRect(),
    })}
    onClose={onClose}
    className="w-64"
  >
    {menu.items.length === 0 ? (
      <p className="text-muted-foreground px-2 py-1.5 text-sm">No results</p>
    ) : (
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a select cannot be driven by the caret in a contenteditable through aria-activedescendant
      <div id={id} role="listbox" aria-label="Block kinds">
        {menu.items.map((item, i) => (
          // oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- the caret stays in the block, whose arrow keys and Enter drive the highlighted option
          <div
            key={item.kind}
            id={optionId(id, item)}
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- an option of the listbox above
            role="option"
            aria-selected={i === menu.active}
            tabIndex={-1}
            className={cn(
              "flex cursor-default flex-col rounded-md px-2 py-1.5 text-sm",
              i === menu.active && "bg-accent"
            )}
            // Keeps the caret in the block while the option is pressed.
            onMouseDown={(e) => {
              e.preventDefault();
            }}
            onClick={() => {
              menu.choose(item);
            }}
          >
            <span>{item.label}</span>
            <span className="text-muted-foreground text-xs">{item.hint}</span>
          </div>
        ))}
      </div>
    )}
  </AnchoredPopover>
);
