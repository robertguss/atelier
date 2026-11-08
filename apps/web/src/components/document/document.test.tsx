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
});

describe("adding, deleting and moving blocks", () => {
  beforeEach(setUp);
  afterEach(tearDown);

  it("adds a paragraph after a block and puts the caret in it", async () => {
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
    await waitFor(() => {
      expect(
        within(
          must(document.querySelector('[data-block-id="b-new"]'))
        ).getByRole("textbox")
      ).toHaveFocus();
    });
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
