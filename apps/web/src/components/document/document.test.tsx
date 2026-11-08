import type { BlockKind } from "@atelier/shared";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { Editor } from "@tiptap/core";
import {
  afterEach,
  assert,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  backend,
  mutation,
  mutationEffect,
  pushBackend,
  resetBackend,
} from "~/test/backend";
import { renderAt } from "~/test/render";

import { BlockEditor } from "./BlockEditor";

// The element comments read a block's text from.
const blockText = (blockId: string) =>
  screen.getByText(
    (_, el) => el instanceof HTMLElement && el.dataset.blockText === blockId
  );

// A block shows static text until the pointer reaches it, then its editor.
const startEditing = (blockId: string) => {
  fireEvent.pointerEnter(blockText(blockId));
  return screen.getByRole("textbox");
};

// The editor instance that Tiptap leaves on the content element.
const editorOf = (element: HTMLElement) => {
  const editor: unknown = Reflect.get(element, "editor");
  assert(editor instanceof Editor);
  return editor;
};

// The same within the open room, where every editable block is a text box.
const startEditingIn = (blockId: string) => {
  fireEvent.pointerEnter(blockText(blockId));
  return blockText(blockId);
};

const must = <T,>(value: T | null): T => {
  assert(value !== null);
  return value;
};

vi.mock(import("convex/react"), async () => {
  const { convexMock } = await import("~/test/backend");
  return convexMock;
});
vi.mock(import("~/auth/ClerkShell"), async () => {
  const { authMock } = await import("~/test/backend");
  return authMock;
});

const ROOM = "room1";
const ROBERT = "p-robert";
const DANA = "p-dana";
const CLAUDE = "p-claude";

interface TestBlock {
  _id: string;
  order: string;
  kind: BlockKind;
  text: string;
  author:
    | { kind: "participant"; participantId: string }
    | { kind: "scribe"; participantId: string; credits: string[] };
  rev: number;
  humanEditedAt?: number;
  leaseHolderParticipantId?: string;
  leaseExpiresAt?: number;
  openThreads: number;
}

let blocks: TestBlock[];

const block = (
  _id: string,
  order: string,
  kind: TestBlock["kind"],
  text: string,
  participantId: string,
  overrides: Partial<TestBlock> = {}
): TestBlock => ({
  _id,
  author: { kind: "participant", participantId },
  kind,
  openThreads: 0,
  order,
  rev: 1,
  text,
  ...overrides,
});

// Convex wraps a function's thrown error in a longer message.
const convexError = (sentence: string) =>
  new Error(
    `[CONVEX M(blocks:save)] [Request ID: abc] Server Error\nUncaught Error: ${sentence}\n    at handler (blocks.ts:1:1)`
  );

const room = (access: "owner" | "member") => {
  backend.queries["rooms:access"] = () => access;
  backend.queries["members:notice"] = () => ({
    acceptedVersion: 1,
    currentVersion: 1,
  });
  backend.queries["me:get"] = () => ({
    email: null,
    isOwner: access === "owner",
    name: null,
    signedIn: true,
    userId: access === "owner" ? "u-robert" : "u-dana",
  });
  backend.queries["rooms:get"] = () => ({
    participants: [
      { _id: ROBERT, displayName: "Robert", kind: "human", userId: "u-robert" },
      { _id: DANA, displayName: "Dana", kind: "human", userId: "u-dana" },
      {
        _id: CLAUDE,
        displayName: "Claude",
        harness: "claude",
        kind: "harness",
      },
    ],
    room: { _id: ROOM, editsEnabled: false, name: "Pricing plan" },
  });
  backend.queries["agent:pane"] = () => ({
    agents: [],
    cards: [],
    editsEnabled: false,
    hasOlder: false,
    messages: [],
    runner: { lastHeartbeatAt: Date.now(), offlineAfterMs: 45_000 },
    turns: [],
  });
  backend.queries["team:list"] = () => [];
  backend.queries["documents:get"] = () => ({
    blocks,
    documentId: "d1",
    rev: 4,
  });
};

const openRoom = async (access: "owner" | "member" = "owner") => {
  room(access);
  renderAt(`/rooms/${ROOM}`);
  await screen.findByRole("region", { name: "Room document" });
};

const patchBlock = (index: number, patch: Partial<TestBlock>) => {
  blocks = blocks.map((b, i) => (i === index ? { ...b, ...patch } : b));
};

// jsdom has no layout, so a drag finds `target` under every point it reaches.
const pointOver = (target: HTMLElement) => {
  document.elementFromPoint = () => target;
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: () => null,
  });
};

const blockWith = (text: string) => {
  const found = screen.getByText(text).closest<HTMLElement>("[data-block-id]");
  if (!found) {
    throw new Error(`No block shows "${text}"`);
  }
  return found;
};

const added = () =>
  must(document.querySelector<HTMLElement>('[data-block-id="b-new"]'));

const setUp = () => {
  resetBackend();
  window.localStorage.clear();
  blocks = [
    block("h1", "a0", "heading", "Ideas & notes", ROBERT),
    block("b1", "a1", "paragraph", "Charge per seat.", CLAUDE, {
      openThreads: 2,
    }),
    block("b2", "a2", "listItem", "Try a free tier", DANA),
    block("h2", "a3", "heading", "Open questions", ROBERT),
  ];
};

const tearDown = () => {
  vi.useRealTimers();
};

describe("reading the document", () => {
  beforeEach(setUp);
  afterEach(tearDown);

  it("seeds the document once when the room opens", async () => {
    await openRoom();
    await waitFor(() => {
      expect(mutation("documents:ensure")).toHaveBeenCalledWith({
        roomId: ROOM,
      });
    });
    act(() => {
      pushBackend();
    });
    expect(mutation("documents:ensure")).toHaveBeenCalledOnce();
  });

  it("renders a line break inside a block", async () => {
    patchBlock(1, { text: "one\ntwo" });
    await openRoom();
    expect(blockText("b1")).toHaveTextContent("onetwo");
    expect(blockText("b1").querySelector("br")).not.toBeNull();
  });

  it("shows each block's text, author and open thread count", async () => {
    await openRoom();
    expect(
      screen.getByRole("heading", { name: "Ideas & notes" })
    ).toBeInTheDocument();
    const paragraph = blockWith("Charge per seat.");
    expect(within(paragraph).getByText("Claude")).toBeInTheDocument();
    expect(within(paragraph).getByText("2 open threads")).toBeInTheDocument();
    expect(
      within(blockWith("Try a free tier")).getByText("Dana")
    ).toBeInTheDocument();
  });

  it('announces "Robert is editing" with his initials on a block Robert holds, which the teammate can read but not edit', async () => {
    patchBlock(1, {
      leaseExpiresAt: Date.now() + 60_000,
      leaseHolderParticipantId: ROBERT,
    });
    await openRoom("member");
    const held = blockWith("Charge per seat.");
    const presence = within(held).getByText("Robert is editing");
    expect(presence.closest("[aria-live]")).toHaveAttribute(
      "aria-live",
      "polite"
    );
    expect(presence).toHaveTextContent("RRobert is editing");
    fireEvent.pointerEnter(blockText("b1"));
    expect(within(held).queryByRole("textbox")).toBeNull();
    expect(within(held).getByRole("button", { name: "Delete" })).toBeDisabled();
    expect(
      within(blockWith("Try a free tier")).getByRole("textbox")
    ).toBeInTheDocument();
  });

  it("keeps a block Robert holds in place, its handle disabled and naming him", async () => {
    patchBlock(1, {
      leaseExpiresAt: Date.now() + 60_000,
      leaseHolderParticipantId: ROBERT,
    });
    await openRoom("member");
    expect(
      within(blockWith("Charge per seat.")).getByRole("button", {
        name: "Reorder block, Robert is editing",
      })
    ).toBeDisabled();
  });

  it("ignores a lease that has already lapsed", async () => {
    patchBlock(1, {
      leaseExpiresAt: Date.now() - 1000,
      leaseHolderParticipantId: ROBERT,
    });
    await openRoom("member");
    const lapsed = blockWith("Charge per seat.");
    expect(
      within(lapsed).queryByText("Robert is editing")
    ).not.toBeInTheDocument();
    expect(within(lapsed).getByRole("textbox")).toBeInTheDocument();
  });
});

describe("editing a block", () => {
  beforeEach(setUp);
  afterEach(tearDown);

  it("takes the lease on the first change to a block, not on pointing at it or focusing it", async () => {
    await openRoom();
    const content = startEditingIn("b1");
    fireEvent.focus(content);
    expect(mutation("blocks:startEdit")).not.toHaveBeenCalled();
    act(() => {
      editorOf(content).commands.insertContentAt(1, "We ");
    });
    await waitFor(() => {
      expect(mutation("blocks:startEdit")).toHaveBeenCalledExactlyOnceWith({
        blockId: "b1",
      });
    });
  });

  it("puts a refused block back to the server's text and offers what was typed as a draft", async () => {
    const writeText = vi
      .fn<(text: string) => Promise<void>>()
      .mockResolvedValue();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    mutation("blocks:startEdit").mockRejectedValue(
      convexError("Robert is editing this block")
    );
    await openRoom("member");
    const paragraph = blockWith("Charge per seat.");
    const content = startEditingIn("b1");
    act(() => {
      editorOf(content).commands.insertContentAt(1, "My ");
    });

    const alert = await within(paragraph).findByRole("alert");
    expect(alert).toHaveTextContent("Robert is editing this block");
    expect(content).toHaveTextContent(/^Charge per seat\.$/u);
    fireEvent.click(
      within(paragraph).getByRole("button", { name: "Copy my draft" })
    );
    expect(writeText).toHaveBeenCalledWith("My Charge per seat.");

    fireEvent.click(
      within(paragraph).getByRole("button", { name: "Discard my draft" })
    );
    expect(within(paragraph).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("stops input that would take a block past 4,000 characters, counting from 3,800", async () => {
    patchBlock(1, { text: "x".repeat(3995) });
    await openRoom();
    const paragraph = must(
      document.querySelector<HTMLElement>('[data-block-id="b1"]')
    );
    const content = startEditingIn("b1");
    expect(paragraph).toHaveTextContent("3,995 of 4,000 characters");

    act(() => {
      editorOf(content).commands.insertContentAt(1, "123456");
    });
    expect(paragraph).toHaveTextContent("3,995 of 4,000 characters");
    act(() => {
      editorOf(content).commands.insertContentAt(1, "12345");
    });
    expect(paragraph).toHaveTextContent("4,000 of 4,000 characters");
  });
});

describe("adding, deleting and moving blocks", () => {
  beforeEach(setUp);
  afterEach(tearDown);

  it("adds an empty paragraph after the last block when the space below it is clicked, and puts the caret in it", async () => {
    mutationEffect(
      "blockOps:insertMany",
      () => {
        blocks.push(
          block("b-new", "a4", "paragraph", "", ROBERT, {
            leaseExpiresAt: Date.now() + 120_000,
            leaseHolderParticipantId: ROBERT,
          })
        );
        pushBackend();
      },
      { blocks: [{ blockId: "b-new", rev: 5 }] }
    );
    await openRoom();
    fireEvent.click(
      screen.getByRole("button", { name: "Add a paragraph at the end" })
    );

    await waitFor(() => {
      expect(mutation("blockOps:insertMany")).toHaveBeenCalledWith({
        afterBlockId: "h2",
        blocks: [{ kind: "paragraph", text: "" }],
        roomId: ROOM,
      });
    });
    await waitFor(() => {
      expect(
        within(
          must(document.querySelector('[data-block-id="b-new"]'))
        ).getByRole("textbox")
      ).toHaveFocus();
    });
  });

  it("does not take focus back to a block that had the caret once, when it remounts later", async () => {
    mutationEffect(
      "blockOps:insertMany",
      () => {
        blocks.push(block("b-new", "a4", "paragraph", "", ROBERT));
        pushBackend();
      },
      { blocks: [{ blockId: "b-new", rev: 5 }] }
    );
    await openRoom();
    fireEvent.click(
      screen.getByRole("button", { name: "Add a paragraph at the end" })
    );
    await waitFor(() => {
      expect(within(added()).getByRole("textbox")).toHaveFocus();
    });
    const first = added();

    // Robert moves on; a while later Dana adds a heading above the new block,
    // which moves it into another section.
    const elsewhere = startEditingIn("b1");
    act(() => {
      elsewhere.focus();
    });
    vi.useFakeTimers({
      toFake: ["Date", "requestAnimationFrame", "setTimeout"],
    });
    vi.setSystemTime(Date.now() + 5000);
    blocks.splice(4, 0, block("h3", "a3V", "heading", "Later", DANA));
    act(() => {
      pushBackend();
    });

    expect(added()).not.toBe(first);
    // Focusing an editor waits for the next frame.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(elsewhere).toHaveFocus();
  });

  it("asks for confirmation before deleting a block", async () => {
    await openRoom();
    const item = blockWith("Try a free tier");
    fireEvent.click(within(item).getByRole("button", { name: "Delete" }));
    expect(mutation("blocks:remove")).not.toHaveBeenCalled();

    fireEvent.click(within(item).getByRole("button", { name: "Keep it" }));
    expect(
      within(item).queryByRole("button", { name: "Delete this block" })
    ).not.toBeInTheDocument();

    fireEvent.click(within(item).getByRole("button", { name: "Delete" }));
    fireEvent.click(
      within(item).getByRole("button", { name: "Delete this block" })
    );
    await waitFor(() => {
      expect(mutation("blocks:remove")).toHaveBeenCalledWith({
        baseRev: 1,
        blockId: "b2",
      });
    });
  });

  it("saves what was just typed before deleting a block from its toolbar, removing it on the saved rev", async () => {
    mutation("blocks:save").mockResolvedValue({ rev: 2 });
    await openRoom();
    const item = blockWith("Try a free tier");
    const content = startEditingIn("b2");
    act(() => {
      editorOf(content).commands.insertContentAt(1, "Maybe ");
    });
    fireEvent.click(within(item).getByRole("button", { name: "Delete" }));
    fireEvent.click(
      within(item).getByRole("button", { name: "Delete this block" })
    );

    await waitFor(() => {
      expect(mutation("blocks:remove")).toHaveBeenCalledWith({
        baseRev: 2,
        blockId: "b2",
      });
    });
    expect(mutation("blocks:save")).toHaveBeenCalledExactlyOnceWith({
      baseRev: 1,
      blockId: "b2",
      text: "Maybe Try a free tier",
    });
  });

  it("moves a block below the next one on Alt+Shift+Down on its handle, announces its new place, and keeps focus on the handle", async () => {
    mutationEffect(
      "blockOps:moveTo",
      () => {
        const [h1, b1, b2, h2] = blocks;
        assert(h1 && b1 && b2 && h2);
        blocks = [h1, b1, h2, { ...b2, order: "a4", rev: 5 }];
        pushBackend();
      },
      { rev: 5 }
    );
    await openRoom();
    const handle = within(blockWith("Try a free tier")).getByRole("button", {
      name: "Reorder block",
    });
    handle.focus();
    fireEvent.keyDown(handle, {
      altKey: true,
      key: "ArrowDown",
      shiftKey: true,
    });

    await waitFor(() => {
      expect(mutation("blockOps:moveTo")).toHaveBeenCalledWith({
        afterBlockId: "h2",
        baseRev: 1,
        blockId: "b2",
      });
    });
    const announced = await screen.findByText("Moved to position 4 of 4");
    expect(announced).toHaveAttribute("aria-live", "polite");
    await waitFor(() => {
      expect(
        within(blockWith("Try a free tier")).getByRole("button", {
          name: "Reorder block",
        })
      ).toHaveFocus();
    });
  });

  it("drags a block by its handle, marking the gap it would drop into, and moves it there on release", async () => {
    mutation("blockOps:moveTo").mockResolvedValue({ rev: 5 });
    await openRoom();
    const dragged = blockWith("Charge per seat.");
    const target = blockWith("Try a free tier");
    // jsdom has no layout: the target spans 100 to 140 px, under any point the pointer reaches.
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ height: 40, width: 600, x: 0, y: 100 })
    );
    pointOver(target);
    const handle = within(dragged).getByRole("button", {
      name: "Reorder block",
    });

    fireEvent.pointerDown(handle, { button: 0, clientX: 10, clientY: 60 });
    fireEvent.pointerMove(handle, { clientX: 10, clientY: 110 });
    expect(target.dataset.drop).toBe("before");
    fireEvent.pointerMove(handle, { clientX: 10, clientY: 130 });
    expect(target.dataset.drop).toBe("after");
    fireEvent.pointerUp(handle, { clientX: 10, clientY: 130 });

    expect(target.dataset.drop).toBeUndefined();
    await waitFor(() => {
      expect(mutation("blockOps:moveTo")).toHaveBeenCalledWith({
        afterBlockId: "b2",
        baseRev: 1,
        blockId: "b1",
      });
    });
    const announced = await screen.findByText("Moved to position 3 of 4");
    expect(announced).toBeInTheDocument();
  });

  it("leaves a block in place when its drag is cancelled", async () => {
    await openRoom();
    const target = blockWith("Try a free tier");
    pointOver(target);
    const handle = within(blockWith("Charge per seat.")).getByRole("button", {
      name: "Reorder block",
    });

    fireEvent.pointerDown(handle, { button: 0, clientX: 10, clientY: 60 });
    fireEvent.pointerMove(handle, { clientX: 10, clientY: 130 });
    expect(target.dataset.drop).toBeDefined();
    fireEvent.keyDown(handle, { key: "Escape" });
    fireEvent.pointerUp(handle, { clientX: 10, clientY: 130 });

    expect(target.dataset.drop).toBeUndefined();
    expect(mutation("blockOps:moveTo")).not.toHaveBeenCalled();
  });

  it("refuses a multi-block paste that would pass the document limit, inserting nothing and keeping the paste as a draft", async () => {
    const writeText = vi
      .fn<(text: string) => Promise<void>>()
      .mockResolvedValue();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const limit =
      "This would add 5 blocks to a document of 598, and a document holds at most 600 blocks.";
    mutation("blockOps:insertMany").mockRejectedValue(convexError(limit));
    await openRoom();
    const paragraph = blockWith("Charge per seat.");
    const content = startEditingIn("b1");
    act(() => {
      editorOf(content).commands.setTextSelection(17);
    });
    const pasted = "One\n\nTwo\n\nThree\n\nFour\n\nFive";
    fireEvent.paste(content, {
      clipboardData: {
        getData: (type: string) => (type === "text/plain" ? pasted : ""),
      },
    });

    await waitFor(() => {
      expect(mutation("blockOps:insertMany")).toHaveBeenCalledWith({
        afterBlockId: "b1",
        blocks: ["One", "Two", "Three", "Four", "Five"].map((text) => ({
          kind: "paragraph",
          text,
        })),
        roomId: ROOM,
        source: { baseRev: 1, headText: "Charge per seat.", tailText: "" },
      });
    });
    const alert = await within(paragraph).findByRole("alert");
    expect(alert).toHaveTextContent(limit);
    expect(content).toHaveTextContent(/^Charge per seat\.$/u);
    expect(screen.queryByText("One")).not.toBeInTheDocument();
    fireEvent.click(
      within(paragraph).getByRole("button", { name: "Copy my draft" })
    );
    expect(writeText).toHaveBeenCalledWith(`Charge per seat.${pasted}`);
  });
});

describe("saving the document as a template", () => {
  beforeEach(setUp);
  afterEach(tearDown);

  it("saves the room's sections as a template under the name Robert gives", async () => {
    await openRoom();
    const pane = within(screen.getByRole("region", { name: "Room document" }));
    fireEvent.click(pane.getByRole("button", { name: "Save as template" }));
    fireEvent.change(pane.getByLabelText("Template name"), {
      target: { value: "Pricing sessions" },
    });
    fireEvent.click(pane.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mutation("templates:saveFromRoom")).toHaveBeenCalledWith({
        name: "Pricing sessions",
        roomId: ROOM,
      });
    });
    await pane.findByText(/saved as a template/iu);
  });

  it("offers a teammate no way to save a template", async () => {
    await openRoom("member");
    expect(
      screen.queryByRole("button", { name: "Save as template" })
    ).not.toBeInTheDocument();
  });
});

describe("a block's editor", () => {
  it("renders read-only text in place with the block id for comments, and writes nothing on mount or blur", () => {
    const onChange = vi.fn<(text: string) => void>();
    render(
      <BlockEditor
        blockId="b1"
        kind="paragraph"
        text="Charge **per seat**."
        editable={false}
        onChange={onChange}
      />
    );
    const content = blockText("b1");
    expect(content).toHaveTextContent("Charge per seat.");
    expect(within(content).getByText("per seat").tagName).toBe("STRONG");
    fireEvent.pointerEnter(content);
    fireEvent.focus(content);
    fireEvent.blur(content);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("never renders a model's script link as a live link", () => {
    render(
      <BlockEditor
        blockId="b1"
        kind="paragraph"
        // oxlint-disable-next-line eslint/no-script-url -- the script link is what this test feeds in
        text="[click](javascript:alert(1))"
        editable={false}
      />
    );
    expect(document.body.innerHTML).not.toContain("javascript");
  });

  it("reports the new text as markdown once the person changes it", () => {
    const onChange = vi.fn<(text: string) => void>();
    render(
      <BlockEditor
        blockId="b1"
        kind="paragraph"
        text="Charge **per seat**."
        editable
        onChange={onChange}
      />
    );
    const content = startEditing("b1");
    fireEvent.focus(content);
    fireEvent.blur(content);
    expect(onChange).not.toHaveBeenCalled();
    act(() => {
      editorOf(content).commands.insertContentAt(1, "We ");
    });
    expect(onChange).toHaveBeenLastCalledWith("We Charge **per seat**.");
  });

  it("takes a remote change to text and kind without remounting or writing back", () => {
    const onChange = vi.fn<(text: string) => void>();
    const props = { blockId: "b1", editable: true, onChange };
    const { rerender } = render(
      <BlockEditor {...props} kind="paragraph" text="Charge per seat." />
    );
    const content = startEditing("b1");
    rerender(
      <BlockEditor {...props} kind="paragraph" text="Charge per *team*." />
    );
    expect(content).toHaveTextContent("Charge per team.");
    expect(within(content).getByText("team").tagName).toBe("EM");

    rerender(
      <BlockEditor {...props} kind="heading" text="Charge per *team*." />
    );
    expect(screen.getByRole("textbox")).toBe(content);
    expect(content.querySelector("h3")).toHaveTextContent("Charge per team.");
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("a block's editor after a split", () => {
  it("keeps comments pointed at the new block once its real id replaces the temporary one", () => {
    const props = {
      editable: true,
      kind: "paragraph",
      text: "per seat.",
    } as const;
    const { rerender } = render(<BlockEditor {...props} blockId="temp-0" />);
    const content = startEditing("temp-0");
    rerender(<BlockEditor {...props} blockId="b9" />);
    expect(content.dataset.blockText).toBe("b9");
  });
});

describe("shaping blocks with the keyboard", () => {
  beforeEach(setUp);
  afterEach(tearDown);

  it("splits a paragraph at the caret on Enter, the new block taking the rest and the caret, and undo in the first part cannot bring the rest back", async () => {
    mutationEffect(
      "blockOps:split",
      () => {
        patchBlock(1, { rev: 2, text: "Charge" });
        blocks.splice(
          2,
          0,
          block("b9", "a1V", "paragraph", " per seat. Yearly.", ROBERT, {
            rev: 3,
          })
        );
        pushBackend();
      },
      { rev: 2, tailId: "b9", tailRev: 3 }
    );
    await openRoom();
    const head = startEditingIn("b1");
    const editor = editorOf(head);
    act(() => {
      editor.commands.insertContentAt(17, " Yearly.");
      editor.commands.setTextSelection(7);
    });
    fireEvent.keyDown(head, { key: "Enter" });

    expect(head).toHaveTextContent(/^Charge$/u);
    await waitFor(() => {
      expect(mutation("blockOps:split")).toHaveBeenCalledExactlyOnceWith({
        baseRev: 1,
        blockId: "b1",
        headText: "Charge",
        tailKind: "paragraph",
        tailText: " per seat. Yearly.",
      });
    });
    await waitFor(() => {
      expect(blockText("b9")).toHaveFocus();
    });
    expect(blockText("b9")).toHaveTextContent("per seat. Yearly.");

    act(() => {
      editor.commands.undo();
    });
    expect(head).toHaveTextContent(/^Charge$/u);
  });

  it("turns a paragraph into an unchecked to-do when [] and a space are typed at its start", async () => {
    mutationEffect(
      "blockOps:setKind",
      () => {
        patchBlock(1, { kind: "todo", rev: 2 });
        pushBackend();
      },
      { rev: 2 }
    );
    await openRoom();
    const paragraph = blockWith("Charge per seat.");
    const content = startEditingIn("b1");
    act(() => {
      editorOf(content).commands.insertContentAt(1, "[]");
      editorOf(content).commands.insertContentAt(3, " ", {
        applyInputRules: true,
      });
    });

    await waitFor(() => {
      expect(mutation("blockOps:setKind")).toHaveBeenCalledExactlyOnceWith({
        baseRev: 1,
        blockId: "b1",
        kind: "todo",
        text: "Charge per seat.",
      });
    });
    expect(
      within(paragraph).getByRole("checkbox", { name: "Charge per seat." })
    ).not.toBeChecked();
    expect(mutation("blocks:save")).not.toHaveBeenCalled();
  });

  it("opens a menu of all eight kinds on /, and choosing one turns the block into it", async () => {
    await openRoom();
    const content = startEditingIn("b1");
    act(() => {
      editorOf(content).commands.insertContentAt(17, " /");
    });

    const menu = await screen.findByRole("listbox", { name: "Block kinds" });
    expect(
      within(menu)
        .getAllByRole("option")
        .map((option) => option.firstChild?.textContent)
    ).toStrictEqual([
      "Heading",
      "Paragraph",
      "List item",
      "To-do",
      "Numbered item",
      "Quote",
      "Code",
      "Divider",
    ]);
    expect(content).toHaveAttribute(
      "aria-activedescendant",
      within(menu).getAllByRole("option")[0]?.id
    );

    fireEvent.click(within(menu).getByRole("option", { name: /^Quote/u }));
    await waitFor(() => {
      expect(mutation("blockOps:setKind")).toHaveBeenCalledWith(
        expect.objectContaining({ blockId: "b1", kind: "quote" })
      );
    });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("moves through the slash menu with the arrows, and Enter on Divider puts a divider below a block that has text", async () => {
    await openRoom();
    const content = startEditingIn("b1");
    act(() => {
      editorOf(content).commands.insertContentAt(17, " /");
    });
    await screen.findByRole("listbox", { name: "Block kinds" });
    fireEvent.keyDown(content, { key: "ArrowUp" });
    expect(screen.getByRole("option", { name: /^Divider/u })).toHaveAttribute(
      "aria-selected",
      "true"
    );

    fireEvent.keyDown(content, { key: "Enter" });
    await waitFor(() => {
      expect(mutation("blockOps:split")).toHaveBeenCalledExactlyOnceWith({
        baseRev: 1,
        blockId: "b1",
        headText: "Charge per seat. ",
        tailKind: "divider",
        tailText: "",
      });
    });
    expect(mutation("blockOps:setKind")).not.toHaveBeenCalled();
  });

  it("turns a to-do into a paragraph on the first Backspace at its start, and merges it into the block above on the second", async () => {
    patchBlock(2, { kind: "todo" });
    mutationEffect(
      "blockOps:setKind",
      () => {
        patchBlock(2, { kind: "paragraph", rev: 2 });
        pushBackend();
      },
      { rev: 2 }
    );
    await openRoom();
    const content = startEditingIn("b2");
    act(() => {
      editorOf(content).commands.setTextSelection(1);
    });
    fireEvent.keyDown(content, { key: "Backspace" });
    await waitFor(() => {
      expect(mutation("blockOps:setKind")).toHaveBeenCalledExactlyOnceWith({
        baseRev: 1,
        blockId: "b2",
        kind: "paragraph",
        text: "Try a free tier",
      });
    });
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();

    fireEvent.keyDown(content, { key: "Backspace" });
    await waitFor(() => {
      expect(mutation("blockOps:merge")).toHaveBeenCalledExactlyOnceWith({
        baseRev: 2,
        blockId: "b2",
        previousBaseRev: 1,
      });
    });
  });

  it("adds an empty block of the same kind above on Enter at the start of a block, keeping the caret where it was", async () => {
    await openRoom();
    const content = startEditingIn("b2");
    act(() => {
      editorOf(content).commands.setTextSelection(1);
    });
    fireEvent.keyDown(content, { key: "Enter" });

    await waitFor(() => {
      expect(mutation("blockOps:insertMany")).toHaveBeenCalledExactlyOnceWith({
        afterBlockId: "b1",
        blocks: [{ kind: "listItem", text: "" }],
        roomId: ROOM,
      });
    });
    expect(content).toHaveTextContent(/^Try a free tier$/u);
    expect(mutation("blockOps:split")).not.toHaveBeenCalled();
  });

  it("refuses to merge into a block Robert holds on Backspace, naming him", async () => {
    patchBlock(2, { kind: "paragraph" });
    patchBlock(1, {
      leaseExpiresAt: Date.now() + 60_000,
      leaseHolderParticipantId: ROBERT,
    });
    await openRoom("member");
    const paragraph = blockWith("Try a free tier");
    const content = startEditingIn("b2");
    act(() => {
      editorOf(content).commands.setTextSelection(1);
    });
    fireEvent.keyDown(content, { key: "Backspace" });

    const alert = await within(paragraph).findByRole("alert");
    expect(alert).toHaveTextContent("Robert is editing the block above");
    expect(mutation("blockOps:merge")).not.toHaveBeenCalled();
  });

  it("removes a divider above on Backspace at the start of the block below it", async () => {
    patchBlock(2, { kind: "paragraph" });
    blocks.splice(2, 0, block("d1", "a1V", "divider", "", ROBERT));
    await openRoom();
    const content = startEditingIn("b2");
    act(() => {
      editorOf(content).commands.setTextSelection(1);
    });
    fireEvent.keyDown(content, { key: "Backspace" });

    await waitFor(() => {
      expect(mutation("blocks:remove")).toHaveBeenCalledExactlyOnceWith({
        baseRev: 1,
        blockId: "d1",
      });
    });
    expect(mutation("blockOps:merge")).not.toHaveBeenCalled();
  });

  it("ticks a to-do at once and records the tick", async () => {
    patchBlock(2, { kind: "todo" });
    await openRoom();
    const box = screen.getByRole("checkbox", { name: "Try a free tier" });
    fireEvent.click(box);
    expect(box).toBeChecked();
    await waitFor(() => {
      expect(mutation("blockOps:toggleChecked")).toHaveBeenCalledWith({
        baseRev: 1,
        blockId: "b2",
        checked: true,
      });
    });
  });
});
