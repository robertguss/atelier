import {
  act,
  fireEvent,
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
const PI = "p-pi";

type MentionState =
  | "waiting"
  | "waitingForRunner"
  | "answering"
  | "replied"
  | "failed"
  | "cancelled";
interface TestComment {
  _id: string;
  at: number;
  authorParticipantId: string;
  body: string;
  mentions: { participantId: string; state: MentionState }[];
}
interface TestThread {
  _id: string;
  blockId: string;
  exact: string;
  prefix: string;
  suffix: string;
  position: number;
  state: "open" | "settled";
  detachedBeforeChangeSetId: string | null;
  comments: TestComment[];
}

const blocks = [
  {
    _id: "h1",
    author: { kind: "participant", participantId: ROBERT },
    kind: "heading",
    openThreads: 0,
    order: "a0",
    rev: 1,
    text: "Ideas & notes",
  },
  {
    _id: "b1",
    author: { kind: "participant", participantId: CLAUDE },
    kind: "paragraph",
    openThreads: 1,
    order: "a1",
    rev: 1,
    text: "Charge **per seat** monthly.",
  },
  {
    _id: "b2",
    author: { kind: "participant", participantId: DANA },
    kind: "listItem",
    openThreads: 1,
    order: "a2",
    rev: 1,
    text: "Try a free tier",
  },
  {
    _id: "b3",
    author: { kind: "participant", participantId: DANA },
    checked: false,
    kind: "todo",
    openThreads: 0,
    order: "a3",
    rev: 1,
    text: "Email **Dana**",
  },
  {
    _id: "b4",
    author: { kind: "participant", participantId: DANA },
    kind: "numberedItem",
    openThreads: 0,
    order: "a4",
    rev: 1,
    text: "Ship v1",
  },
];

let threads: TestThread[];

const comment = (
  _id: string,
  authorParticipantId: string,
  body: string,
  mentions: TestComment["mentions"] = []
): TestComment => ({
  _id,
  at: Date.UTC(2026, 10, 7, 9, 30),
  authorParticipantId,
  body,
  mentions,
});

const thread = (
  _id: string,
  blockId: string,
  exact: string,
  position: number,
  comments: TestComment[],
  overrides: Partial<TestThread> = {}
): TestThread => ({
  _id,
  blockId,
  comments,
  detachedBeforeChangeSetId: null,
  exact,
  position,
  prefix: "",
  state: "open",
  suffix: "",
  ...overrides,
});

const openRoom = async (doc: Record<string, unknown> = {}) => {
  backend.queries["rooms:access"] = () => "owner";
  backend.queries["members:notice"] = () => ({
    acceptedVersion: 1,
    currentVersion: 1,
  });
  backend.queries["me:get"] = () => ({
    email: null,
    isOwner: true,
    name: null,
    signedIn: true,
    userId: "u-robert",
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
      { _id: PI, displayName: "Pi", harness: "pi", kind: "harness" },
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
    ...doc,
  });
  backend.queries["threads:list"] = () => ({
    open: threads.filter((t) => t.state === "open"),
    settled: threads.filter((t) => t.state === "settled"),
  });
  renderAt(`/rooms/${ROOM}`);
  return await screen.findByRole("complementary", { name: "Comments" });
};

const setThreadState = (name: string, state: TestThread["state"]) => {
  mutationEffect(name, (args) => {
    threads = threads.map((t) =>
      t._id === args?.threadId ? { ...t, state } : t
    );
    pushBackend();
  });
};

const must = <T,>(value: T | null | undefined): T => {
  assert(value !== null && value !== undefined);
  return value;
};

// Selects rendered text in a block the way a reader's drag would.
const selectInBlock = (
  blockId: string,
  from: [Node, number],
  to: [Node, number]
) => {
  const range = document.createRange();
  range.setStart(...from);
  range.setEnd(...to);
  const selection = must(document.getSelection());
  selection.removeAllRanges();
  selection.addRange(range);
  act(() => {
    document.dispatchEvent(new Event("selectionchange"));
  });
  return must(
    document.querySelector<HTMLElement>(`[data-block-id="${blockId}"]`)
  );
};

// The element comments read a block's text from, static or an editor.
const blockText = (blockId: string) =>
  must(document.querySelector<HTMLElement>(`[data-block-text="${blockId}"]`));

// A stand-in for the CSS Custom Highlight API, which jsdom lacks.
class TestHighlight {
  ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}
const stubHighlights = () => {
  const registry = new Map<string, TestHighlight>();
  vi.stubGlobal("CSS", { highlights: registry });
  vi.stubGlobal("Highlight", TestHighlight);
  return registry;
};

const threadCard = (exact: string) =>
  screen.getByRole("article", { name: `Thread on “${exact}”` });

const setUp = () => {
  resetBackend();
  window.localStorage.clear();
  document.getSelection()?.removeAllRanges();
  threads = [];
};

const tearDown = () => {
  vi.unstubAllGlobals();
};

describe("starting a thread", () => {
  beforeEach(setUp);
  afterEach(tearDown);

  it("comments on a selection that crosses markdown emphasis, at the offsets of the stored text, with the @mention in the body", async () => {
    await openRoom();
    const paragraph = must(document.querySelector('[data-block-text="b1"] p'));
    const block = selectInBlock(
      "b1",
      [must(paragraph.firstChild), 3],
      [must(paragraph.querySelector("strong")?.firstChild), 3]
    );
    fireEvent.click(within(block).getByRole("button", { name: "Comment" }));

    const composer = within(block).getByRole("group", { name: "New comment" });
    expect(within(composer).getByText("rge **per")).toBeInTheDocument();
    const input = within(composer).getByRole("textbox", { name: "Comment" });
    fireEvent.change(input, { target: { value: "Is this right @" } });
    const options = within(composer)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(options).toStrictEqual(["Claude", "Pi"]);

    fireEvent.change(input, { target: { value: "Is this right @Cl" } });
    fireEvent.click(within(composer).getByRole("option", { name: "Claude" }));
    expect(input).toHaveValue("Is this right @Claude ");

    fireEvent.change(input, {
      target: { value: "Is this right @Claude for teams?" },
    });
    fireEvent.click(
      within(composer).getByRole("button", { name: "Post comment" })
    );
    await waitFor(() => {
      expect(mutation("threads:create")).toHaveBeenCalledWith({
        blockId: "b1",
        body: "Is this right @Claude for teams?",
        end: 12,
        start: 3,
      });
    });
    await waitFor(() =>
      expect(
        within(block).queryByRole("group", { name: "New comment" })
      ).not.toBeInTheDocument()
    );
  });

  it("posts a comment without a mention as a plain body", async () => {
    await openRoom();
    const item = must(document.querySelector('[data-block-text="b2"] p'));
    const block = selectInBlock(
      "b2",
      [must(item.firstChild), 4],
      [must(item.firstChild), 15]
    );
    fireEvent.click(within(block).getByRole("button", { name: "Comment" }));
    const input = within(block).getByRole("textbox", { name: "Comment" });
    fireEvent.change(input, { target: { value: "Only for students" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(mutation("threads:create")).toHaveBeenCalledWith({
        blockId: "b2",
        body: "Only for students",
        end: 15,
        start: 4,
      });
    });
  });

  it("offers no Comment button without a selection in a block", async () => {
    await openRoom();
    expect(
      screen.queryByRole("button", { name: "Comment" })
    ).not.toBeInTheDocument();
  });

  it.each([
    [
      "a block Dana is editing",
      {
        blocks: blocks.map((b) =>
          b._id === "b1"
            ? {
                ...b,
                leaseExpiresAt: Date.now() + 60_000,
                leaseHolderParticipantId: DANA,
              }
            : b
        ),
      },
    ],
    [
      "a block during a scribe run",
      { scribeLockExpiresAt: Date.now() + 60_000, scribeRunId: "run1" },
    ],
  ])(
    "comments on %s at the offsets of the stored text, without taking the block",
    async (_, doc) => {
      await openRoom(doc);
      const strong = must(
        document.querySelector('[data-block-text="b1"] strong')?.firstChild
      );
      const block = selectInBlock("b1", [strong, 0], [strong, 8]);
      fireEvent.click(within(block).getByRole("button", { name: "Comment" }));
      const input = within(block).getByRole("textbox", { name: "Comment" });
      fireEvent.change(input, { target: { value: "Per team?" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => {
        expect(mutation("threads:create")).toHaveBeenCalledWith({
          blockId: "b1",
          body: "Per team?",
          end: 17,
          start: 9,
        });
      });
      expect(mutation("blocks:startEdit")).not.toHaveBeenCalled();
    }
  );

  it("offers no Comment button for a selection that spans two blocks", async () => {
    await openRoom();
    const first = must(
      document.querySelector('[data-block-text="b1"] p')?.firstChild
    );
    const second = must(
      document.querySelector('[data-block-text="b2"] p')?.firstChild
    );
    selectInBlock("b1", [first, 2], [second, 3]);
    expect(
      screen.queryByRole("button", { name: "Comment" })
    ).not.toBeInTheDocument();
  });

  it.each([
    ["to-do", "b3", 12],
    ["numbered item", "b4", 7],
  ])(
    "anchors a comment on the whole of a %s to its stored text alone, without its box or number",
    async (_, blockId, end) => {
      await openRoom();
      const text = must(
        document.querySelector(`[data-block-text="${blockId}"]`)
      );
      const block = selectInBlock(
        blockId,
        [text, 0],
        [text, text.childNodes.length]
      );
      fireEvent.click(within(block).getByRole("button", { name: "Comment" }));
      const input = within(block).getByRole("textbox", { name: "Comment" });
      fireEvent.change(input, { target: { value: "Whole item" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => {
        expect(mutation("threads:create")).toHaveBeenCalledWith({
          blockId,
          body: "Whole item",
          end,
          start: 0,
        });
      });
    }
  );
});

describe("the margin", () => {
  beforeEach(setUp);
  afterEach(tearDown);

  it("lists open threads in block order, each with its passage and every comment with its author", async () => {
    threads = [
      thread("t2", "b2", "free tier", 6, [
        comment("c2", DANA, "For students?"),
      ]),
      thread("t1", "b1", "per seat", 9, [
        comment("c1", ROBERT, "Or per team?"),
        comment("c3", CLAUDE, "Per team is simpler to bill."),
      ]),
    ];
    const margin = await openRoom();
    const cards = within(margin).getAllByRole("article");
    expect(cards.map((c) => c.getAttribute("aria-label"))).toStrictEqual([
      "Thread on “per seat”",
      "Thread on “free tier”",
    ]);
    const first = within(must(cards[0]));
    expect(
      first.getByText("Per team is simpler to bill.").closest("li")
    ).toHaveTextContent("Claude");
    expect(first.getByText("Or per team?").closest("li")).toHaveTextContent(
      "Robert"
    );
  });

  it("highlights the passages of open threads where the browser supports it", async () => {
    const registry = stubHighlights();
    threads = [
      thread("t1", "b1", "per seat", 9, [
        comment("c1", ROBERT, "Or per team?"),
      ]),
    ];
    await openRoom();
    await waitFor(() => {
      expect(
        registry.get("atelier-comment")?.ranges.map((r) => r.toString())
      ).toStrictEqual(["per seat"]);
    });
  });

  it("keeps a highlight on its passage when an editor replaces the block's text and after a neighbouring block changes", async () => {
    const registry = stubHighlights();
    threads = [
      thread("t1", "b1", "per seat", 9, [
        comment("c1", ROBERT, "Or per team?"),
      ]),
    ];
    await openRoom();
    // Marked on text the page shows now, not on text an editor replaced.
    const expectMarkedInB1 = async () => {
      await waitFor(() => {
        const ranges = registry.get("atelier-comment")?.ranges ?? [];
        expect(ranges.map((r) => r.toString())).toStrictEqual(["per seat"]);
        expect(
          blockText("b1").contains(must(ranges[0]).startContainer)
        ).toBeTruthy();
      });
    };
    await expectMarkedInB1();

    fireEvent.pointerEnter(blockText("b1"));
    await expectMarkedInB1();

    fireEvent.pointerEnter(blockText("b2"));
    const neighbour: unknown = Reflect.get(blockText("b2"), "editor");
    assert(neighbour instanceof Editor);
    act(() => {
      neighbour.commands.insertContentAt(1, "Then ");
    });
    expect(blockText("b2")).toHaveTextContent("Then Try a free tier");
    await expectMarkedInB1();
  });

  it("replies in a thread", async () => {
    threads = [
      thread("t1", "b1", "per seat", 9, [
        comment("c1", ROBERT, "Or per team?"),
      ]),
    ];
    await openRoom();
    const card = threadCard("per seat");
    fireEvent.click(within(card).getByRole("button", { name: "Reply" }));
    fireEvent.change(within(card).getByRole("textbox", { name: "Reply" }), {
      target: { value: "Agreed, @Pi?" },
    });
    fireEvent.click(within(card).getByRole("button", { name: "Post reply" }));
    await waitFor(() => {
      expect(mutation("threads:reply")).toHaveBeenCalledWith({
        body: "Agreed, @Pi?",
        threadId: "t1",
      });
    });
  });
});

describe("settling and reopening", () => {
  beforeEach(setUp);
  afterEach(tearDown);

  it("moves a settled thread into the collapsed Settled section, and Reopen moves it back", async () => {
    setThreadState("threads:settle", "settled");
    setThreadState("threads:reopen", "open");
    threads = [
      thread("t1", "b1", "per seat", 9, [
        comment("c1", ROBERT, "Or per team?"),
      ]),
    ];
    const margin = await openRoom();
    fireEvent.click(
      within(threadCard("per seat")).getByRole("button", { name: "Settle" })
    );
    await waitFor(() => {
      expect(mutation("threads:settle")).toHaveBeenCalledWith({
        threadId: "t1",
      });
    });

    const toggle = await within(margin).findByRole("button", {
      name: "Settled (1)",
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(margin).queryByRole("article")).not.toBeInTheDocument();

    fireEvent.click(toggle);
    fireEvent.click(
      within(threadCard("per seat")).getByRole("button", { name: "Reopen" })
    );
    await waitFor(() => {
      expect(mutation("threads:reopen")).toHaveBeenCalledWith({
        threadId: "t1",
      });
    });
    expect(
      within(margin).queryByRole("button", { name: /Settled/u })
    ).not.toBeInTheDocument();
    expect(
      within(threadCard("per seat")).getByRole("button", { name: "Settle" })
    ).toBeInTheDocument();
  });
});

describe("a thread whose passage was removed", () => {
  beforeEach(setUp);
  afterEach(tearDown);

  it("says so and opens the version just before the change that removed it", async () => {
    backend.queries["history:versionBefore"] = ({ changeSetId }) =>
      changeSetId === "cs9"
        ? {
            blocks: [
              {
                author: { kind: "participant", participantId: ROBERT },
                blockId: "h1",
                kind: "heading",
                order: "a0",
                text: "Ideas & notes",
              },
              {
                author: { kind: "participant", participantId: DANA },
                blockId: "b0",
                kind: "paragraph",
                order: "a05",
                text: "Offer an annual discount.",
              },
            ],
            changeSetId: "cs9",
            rev: 8,
          }
        : null;
    threads = [
      thread(
        "t1",
        "b0",
        "annual discount",
        9,
        [comment("c1", ROBERT, "How much?")],
        { detachedBeforeChangeSetId: "cs9" }
      ),
    ];
    await openRoom();
    const card = threadCard("annual discount");
    expect(within(card).getByText("Passage removed")).toBeInTheDocument();
    fireEvent.click(
      within(card).getByRole("button", { name: "View original" })
    );

    const original = await screen.findByRole("dialog", {
      name: "Original passage",
    });
    expect(
      within(original).getByText("Offer an annual discount.")
    ).toBeInTheDocument();
    expect(
      within(original)
        .getByText("Offer an annual discount.")
        .closest('[data-mark="commented"]')
    ).not.toBeNull();
  });
});

describe("mentions of models", () => {
  beforeEach(setUp);
  afterEach(tearDown);

  it('shows "waiting for Claude" while Claude is busy, and its reply under its name once it arrives', async () => {
    threads = [
      thread("t1", "b1", "per seat", 9, [
        comment("c1", ROBERT, "@Claude is this right?", [
          { participantId: CLAUDE, state: "waiting" },
        ]),
      ]),
    ];
    await openRoom();
    const card = threadCard("per seat");
    expect(within(card).getByText("waiting for Claude")).toBeInTheDocument();

    threads = [
      thread("t1", "b1", "per seat", 9, [
        comment("c1", ROBERT, "@Claude is this right?", [
          { participantId: CLAUDE, state: "replied" },
        ]),
        comment("c2", CLAUDE, "Yes, per seat matches the cost."),
      ]),
    ];
    act(() => {
      pushBackend();
    });
    expect(
      within(card).queryByText("waiting for Claude")
    ).not.toBeInTheDocument();
    expect(within(card).getByText("Claude replied")).toBeInTheDocument();
    expect(
      within(card).getByText("Yes, per seat matches the cost.").closest("li")
    ).toHaveTextContent("Claude");
  });

  it("shows each mention's delivery state", async () => {
    threads = [
      thread("t1", "b1", "per seat", 9, [
        comment("c1", ROBERT, "@Claude @Pi thoughts?", [
          { participantId: CLAUDE, state: "answering" },
          { participantId: PI, state: "waitingForRunner" },
        ]),
        comment("c2", DANA, "@Pi again?", [
          { participantId: PI, state: "failed" },
        ]),
      ]),
    ];
    await openRoom();
    const card = threadCard("per seat");
    expect(within(card).getByText("Claude is answering")).toBeInTheDocument();
    expect(
      within(card).getByText("waiting for the runner")
    ).toBeInTheDocument();
    expect(within(card).getByText("Pi could not reply")).toBeInTheDocument();
  });
});
