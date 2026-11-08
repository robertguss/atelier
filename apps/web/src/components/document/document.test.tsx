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
  kind: "heading" | "paragraph" | "listItem";
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

const blockWith = (text: string) => {
  const found = screen.getByText(text).closest<HTMLElement>("[data-block-id]");
  if (!found) {
    throw new Error(`No block shows "${text}"`);
  }
  return found;
};

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
    expect(blockWith("one two").querySelector(".block-text")).not.toBeNull();
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

  it('shows "Robert is editing" to the teammate on a block Robert holds, and disables its controls', async () => {
    patchBlock(1, {
      leaseExpiresAt: Date.now() + 60_000,
      leaseHolderParticipantId: ROBERT,
    });
    await openRoom("member");
    const held = blockWith("Charge per seat.");
    expect(within(held).getByText("Robert is editing")).toBeInTheDocument();
    expect(within(held).getByRole("button", { name: "Edit" })).toBeDisabled();
    expect(within(held).getByRole("button", { name: "Delete" })).toBeDisabled();
    expect(
      within(blockWith("Try a free tier")).getByRole("button", { name: "Edit" })
    ).toBeEnabled();
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
    expect(within(lapsed).getByRole("button", { name: "Edit" })).toBeEnabled();
  });
});

describe("editing a block", () => {
  beforeEach(setUp);
  afterEach(tearDown);

  it("shows the server's sentence when starting an edit is refused", async () => {
    mutation("blocks:startEdit").mockRejectedValue(
      convexError("Robert is editing this block")
    );
    await openRoom("member");
    const paragraph = blockWith("Charge per seat.");
    fireEvent.click(within(paragraph).getByRole("button", { name: "Edit" }));
    await within(paragraph).findByText("Robert is editing this block");
    expect(
      screen.queryByRole("textbox", { name: "Edit paragraph" })
    ).not.toBeInTheDocument();
  });

  it("saves the edited text on Enter, Shift+Enter adds a line, and a live update re-renders the block", async () => {
    mutationEffect("blocks:save", (args) => {
      patchBlock(1, { text: String(args?.text) });
      pushBackend();
    });
    await openRoom();
    fireEvent.click(
      within(blockWith("Charge per seat.")).getByRole("button", {
        name: "Edit",
      })
    );
    await waitFor(() => {
      expect(mutation("blocks:startEdit")).toHaveBeenCalledWith({
        blockId: "b1",
      });
    });
    const editor = await screen.findByRole("textbox", {
      name: "Edit paragraph",
    });
    expect(editor).toHaveValue("Charge per seat.");

    fireEvent.change(editor, {
      target: { value: "Charge per seat, with a floor." },
    });
    fireEvent.keyDown(editor, { key: "Enter", shiftKey: true });
    expect(mutation("blocks:save")).not.toHaveBeenCalled();

    fireEvent.keyDown(editor, { key: "Enter" });
    await waitFor(() => {
      expect(mutation("blocks:save")).toHaveBeenCalledWith({
        blockId: "b1",
        text: "Charge per seat, with a floor.",
      });
    });
    await waitFor(() => {
      expect(mutation("blocks:stopEdit")).toHaveBeenCalledWith({
        blockId: "b1",
      });
    });
    expect(
      screen.queryByRole("textbox", { name: "Edit paragraph" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Charge per seat, with a floor.")
    ).toBeInTheDocument();
  });

  it("saves when the person leaves the textarea", async () => {
    await openRoom();
    fireEvent.click(
      within(blockWith("Try a free tier")).getByRole("button", { name: "Edit" })
    );
    const editor = await screen.findByRole("textbox", {
      name: "Edit list item",
    });
    fireEvent.change(editor, {
      target: { value: "Try a free tier for teams" },
    });
    fireEvent.blur(editor);
    await waitFor(() => {
      expect(mutation("blocks:save")).toHaveBeenCalledWith({
        blockId: "b2",
        text: "Try a free tier for teams",
      });
    });
  });

  it("renews the lease while the person keeps typing", async () => {
    await openRoom();
    fireEvent.click(
      within(blockWith("Charge per seat.")).getByRole("button", {
        name: "Edit",
      })
    );
    const editor = await screen.findByRole("textbox", {
      name: "Edit paragraph",
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    fireEvent.change(editor, { target: { value: "Charge per seat" } });
    expect(mutation("blocks:renew")).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + 31_000);
    fireEvent.change(editor, { target: { value: "Charge per seat, monthly" } });
    fireEvent.change(editor, {
      target: { value: "Charge per seat, monthly." },
    });
    expect(mutation("blocks:renew")).toHaveBeenCalledExactlyOnceWith({
      blockId: "b1",
    });
  });

  it("keeps the textarea open with the typed text when the lease has lapsed, and lets the person retake it", async () => {
    await openRoom();
    fireEvent.click(
      within(blockWith("Charge per seat.")).getByRole("button", {
        name: "Edit",
      })
    );
    const editor = await screen.findByRole("textbox", {
      name: "Edit paragraph",
    });
    mutation("blocks:save").mockRejectedValue(
      convexError("Your edit lock on this block has lapsed")
    );
    fireEvent.change(editor, { target: { value: "Charge per seat, yearly" } });
    fireEvent.keyDown(editor, { key: "Enter" });

    await screen.findByText("Your edit lock on this block has lapsed");
    expect(screen.getByRole("textbox", { name: "Edit paragraph" })).toHaveValue(
      "Charge per seat, yearly"
    );
    expect(mutation("blocks:stopEdit")).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Retake the block" }));
    await waitFor(() => {
      expect(mutation("blocks:startEdit")).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByRole("textbox", { name: "Edit paragraph" })).toHaveValue(
      "Charge per seat, yearly"
    );
  });

  it("offers to copy the draft when someone else now holds the block", async () => {
    const writeText = vi
      .fn<(text: string) => Promise<void>>()
      .mockResolvedValue();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    await openRoom("member");
    fireEvent.click(
      within(blockWith("Charge per seat.")).getByRole("button", {
        name: "Edit",
      })
    );
    const editor = await screen.findByRole("textbox", {
      name: "Edit paragraph",
    });

    patchBlock(1, {
      leaseExpiresAt: Date.now() + 60_000,
      leaseHolderParticipantId: ROBERT,
    });
    act(() => {
      pushBackend();
    });
    mutation("blocks:save").mockRejectedValue(
      convexError("Robert is editing this block")
    );
    fireEvent.change(editor, { target: { value: "My version" } });
    fireEvent.keyDown(editor, { key: "Enter" });

    await screen.findByText("Robert is editing this block");
    expect(
      screen.queryByRole("button", { name: "Retake the block" })
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy my draft" }));
    expect(writeText).toHaveBeenCalledWith("My version");
  });
});

describe("adding, deleting and moving blocks", () => {
  beforeEach(setUp);
  afterEach(tearDown);

  it("adds a paragraph after a block and opens it for editing", async () => {
    mutationEffect(
      "blocks:add",
      () => {
        blocks.splice(
          2,
          0,
          block("b-new", "a1V", "paragraph", "", ROBERT, {
            leaseExpiresAt: Date.now() + 120_000,
            leaseHolderParticipantId: ROBERT,
          })
        );
        pushBackend();
      },
      "b-new"
    );
    await openRoom();
    const paragraph = blockWith("Charge per seat.");
    fireEvent.click(
      within(paragraph).getByRole("button", { name: "Add below" })
    );
    fireEvent.click(
      within(paragraph).getByRole("button", { name: "Paragraph" })
    );

    await waitFor(() => {
      expect(mutation("blocks:add")).toHaveBeenCalledWith({
        afterBlockId: "b1",
        kind: "paragraph",
        roomId: ROOM,
        text: "",
      });
    });
    const textbox = await screen.findByRole("textbox", {
      name: "Edit paragraph",
    });
    expect(textbox).toHaveValue("");
  });

  it("adds a list item at the end of a section", async () => {
    await openRoom();
    fireEvent.click(
      screen.getByRole("button", { name: "Add to Ideas & notes" })
    );
    fireEvent.click(screen.getByRole("button", { name: "List item" }));
    await waitFor(() => {
      expect(mutation("blocks:add")).toHaveBeenCalledWith({
        endOfSectionId: "h1",
        kind: "listItem",
        roomId: ROOM,
        text: "",
      });
    });
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
        blockId: "b2",
      });
    });
  });

  it("moves a block down, and offers no move up for the first block", async () => {
    await openRoom();
    fireEvent.click(
      within(blockWith("Charge per seat.")).getByRole("button", {
        name: "Move down",
      })
    );
    await waitFor(() => {
      expect(mutation("blocks:move")).toHaveBeenCalledWith({
        blockId: "b1",
        direction: "down",
      });
    });
    expect(
      within(blockWith("Ideas & notes")).getByRole("button", {
        name: "Move up",
      })
    ).toBeDisabled();
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

// The editor instance that Tiptap leaves on the content element.
const editorOf = (element: HTMLElement) => {
  const editor: unknown = Reflect.get(element, "editor");
  assert(editor instanceof Editor);
  return editor;
};

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
