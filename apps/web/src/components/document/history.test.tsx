import { fireEvent, screen, waitFor, within } from "@testing-library/react";
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
  paginate,
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

type Kind =
  | "template_seed"
  | "model_turn"
  | "human_edit"
  | "scribe_run"
  | "restore";
interface ChangeSet {
  _id: string;
  kind: Kind;
  actorParticipantId?: string;
  at: number;
  revisionCount: number;
}

const by = (participantId: string) => ({ kind: "participant", participantId });
const at = (minute: number) => Date.UTC(2026, 10, 7, 9, minute);

const current = [
  {
    _id: "h1",
    author: by(ROBERT),
    kind: "heading",
    openThreads: 0,
    order: "a0",
    rev: 30,
    text: "Ideas & notes",
  },
  {
    _id: "b1",
    author: by(CLAUDE),
    kind: "paragraph",
    openThreads: 0,
    order: "a1",
    rev: 30,
    text: "Charge per team.",
  },
];

let changeSets: ChangeSet[];

// The newest twenty-two versions: a restore, one scribe run of many block
// changes, a model's turn, two edits, sixteen older edits and, oldest, the
// template seeding, which is past the first page.
const history = (): ChangeSet[] => {
  const older = Array.from({ length: 16 }, (_, i): ChangeSet => ({
    _id: `old${i}`,
    actorParticipantId: ROBERT,
    at: at(20 - i),
    kind: "human_edit",
    revisionCount: 1,
  }));
  return [
    {
      _id: "cs-restore",
      actorParticipantId: ROBERT,
      at: at(50),
      kind: "restore",
      revisionCount: 2,
    },
    {
      _id: "cs-scribe",
      actorParticipantId: CLAUDE,
      at: at(45),
      kind: "scribe_run",
      revisionCount: 9,
    },
    {
      _id: "cs-pi",
      actorParticipantId: PI,
      at: at(40),
      kind: "model_turn",
      revisionCount: 3,
    },
    {
      _id: "cs-dana",
      actorParticipantId: DANA,
      at: at(35),
      kind: "human_edit",
      revisionCount: 2,
    },
    {
      _id: "cs-robert",
      actorParticipantId: ROBERT,
      at: at(30),
      kind: "human_edit",
      revisionCount: 1,
    },
    ...older,
    {
      _id: "cs-seed",
      actorParticipantId: ROBERT,
      at: at(0),
      kind: "template_seed",
      revisionCount: 3,
    },
  ];
};

const openRoom = () => {
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
    blocks: current,
    documentId: "d1",
    rev: 30,
  });
  backend.queries["threads:list"] = () => ({ open: [], settled: [] });
  backend.queries["history:list"] = paginate(() => changeSets);
  // Dana's edit: she rewrote one paragraph, added a list item and removed
  // another paragraph; the heading was untouched.
  backend.queries["history:version"] = ({ changeSetId }) =>
    changeSetId === "cs-dana"
      ? {
          blocks: [
            {
              author: by(ROBERT),
              blockId: "h1",
              kind: "heading",
              order: "a0",
              text: "Ideas & notes",
            },
            {
              author: by(CLAUDE),
              blockId: "b1",
              kind: "paragraph",
              order: "a1",
              text: "Charge per seat, billed monthly.",
            },
            {
              author: by(DANA),
              blockId: "b3",
              kind: "listItem",
              order: "a3",
              text: "Try a free tier",
            },
          ],
          changeSetId,
          rev: 12,
        }
      : {
          blocks: current.map(({ _id, order, kind, text, author }) => ({
            author,
            blockId: _id,
            kind,
            order,
            text,
          })),
          changeSetId,
          rev: 30,
        };
  backend.queries["history:diff"] = ({ changeSetId }) =>
    changeSetId === "cs-dana"
      ? [
          {
            after: {
              author: by(CLAUDE),
              kind: "paragraph",
              order: "a1",
              text: "Charge per seat, billed monthly.",
            },
            before: {
              author: by(CLAUDE),
              kind: "paragraph",
              order: "a1",
              text: "Charge per seat.",
            },
            blockId: "b1",
            op: "update",
            rev: 10,
          },
          {
            before: {
              author: by(PI),
              kind: "paragraph",
              order: "a2",
              text: "Offer an annual discount.",
            },
            blockId: "b2",
            op: "delete",
            rev: 11,
          },
          {
            after: {
              author: by(DANA),
              kind: "listItem",
              order: "a3",
              text: "Try a free tier",
            },
            blockId: "b3",
            op: "insert",
            rev: 12,
          },
        ]
      : [];
  renderAt(`/rooms/${ROOM}`);
};

const openHistory = async () => {
  openRoom();
  fireEvent.click(await screen.findByRole("button", { name: "History" }));
  return await screen.findByRole("dialog", { name: "History" });
};

const entryTitles = (panel: HTMLElement) => {
  const list = within(panel).getByRole("list", { name: "Versions" });
  return within(list)
    .getAllByRole("listitem")
    .map((item) => item.querySelector("[data-entry-title]")?.textContent);
};

const setUp = () => {
  resetBackend();
  window.localStorage.clear();
  changeSets = history();
};

const tearDown = () => {
  vi.restoreAllMocks();
};

describe("the history list", () => {
  beforeEach(setUp);
  afterEach(tearDown);

  it("lists change sets newest first with who made each and what kind it was, a scribe run as one entry", async () => {
    const panel = await openHistory();
    const titles = entryTitles(panel);
    expect(titles.slice(0, 5)).toStrictEqual([
      "Restore by Robert",
      "Scribe run by Claude",
      "Pi's turn",
      "Edit by Dana",
      "Edit by Robert",
    ]);
    expect(
      titles.filter((t) => t?.startsWith("Scribe run") === true)
    ).toHaveLength(1);
    expect(titles).toHaveLength(20);
    expect(titles).not.toContain("Template seeding by Robert");
  });

  it("loads older versions on request", async () => {
    const panel = await openHistory();
    fireEvent.click(
      within(panel).getByRole("button", { name: "Load older versions" })
    );
    await waitFor(() => {
      expect(entryTitles(panel)).toHaveLength(22);
    });
    expect(entryTitles(panel).at(-1)).toBe("Template seeding by Robert");
    expect(
      within(panel).queryByRole("button", { name: "Load older versions" })
    ).not.toBeInTheDocument();
  });
});

// Opens the history on "Edit by Dana", whose change set added, changed and removed a block.
const openDanaEdit = async () => {
  const panel = await openHistory();
  fireEvent.click(
    within(panel).getByRole("button", { name: /^Edit by Dana/u })
  );
  const version = await within(panel).findByRole("region", {
    name: "Version: Edit by Dana",
  });
  return { panel, version };
};

const blockOf = (version: HTMLElement, text: string) => {
  const found = within(version)
    .getByText(text)
    .closest<HTMLElement>("[data-version-block]");
  assert(found);
  return found;
};

describe("a selected version", () => {
  beforeEach(setUp);
  afterEach(tearDown);

  it("marks the blocks its change set added, changed and removed", async () => {
    const { version } = await openDanaEdit();
    const changed = blockOf(version, "Charge per seat, billed monthly.");
    expect(changed).toHaveAttribute("data-mark", "changed");
    expect(within(changed).getByText("Changed")).toBeInTheDocument();
    expect(blockOf(version, "Try a free tier")).toHaveAttribute(
      "data-mark",
      "added"
    );
    expect(blockOf(version, "Offer an annual discount.")).toHaveAttribute(
      "data-mark",
      "removed"
    );
    expect(blockOf(version, "Ideas & notes")).not.toHaveAttribute("data-mark");
  });

  it("shows a removed block where it stood, between the two it came between", async () => {
    const { version } = await openDanaEdit();
    expect(
      within(version)
        .getAllByText(/Charge per seat, billed|Offer an annual|Try a free/u)
        .map((n) => n.textContent)
    ).toStrictEqual([
      "Charge per seat, billed monthly.",
      "Offer an annual discount.",
      "Try a free tier",
    ]);
  });

  it("shows that version read-only, and goes back to the list", async () => {
    const { panel, version } = await openDanaEdit();
    expect(within(version).queryByRole("textbox")).not.toBeInTheDocument();
    expect(
      within(version).queryByRole("button", { name: /^Edit/u })
    ).not.toBeInTheDocument();

    fireEvent.click(
      within(panel).getByRole("button", { name: "All versions" })
    );
    expect(
      within(panel).getByRole("list", { name: "Versions" })
    ).toBeInTheDocument();
  });

  it("offers no restore for the newest version, which is the document as it is now", async () => {
    const panel = await openHistory();
    fireEvent.click(
      within(panel).getByRole("button", { name: /^Restore by Robert/u })
    );
    await within(panel).findByText("This is the document as it is now.");
    expect(
      within(panel).queryByRole("button", { name: "Restore this version" })
    ).not.toBeInTheDocument();
  });
});

describe("restoring a version", () => {
  beforeEach(setUp);
  afterEach(tearDown);

  it("asks for confirmation, calls restore once, and shows its refusal", async () => {
    mutation("history:restore").mockRejectedValue(
      new Error(
        "[CONVEX M(history:restore)] [Request ID: 1] Server Error\nUncaught Error: Robert is editing a block\n    at handler (history.ts:1:1)"
      )
    );
    const panel = await openHistory();
    fireEvent.click(
      within(panel).getByRole("button", { name: /^Edit by Dana/u })
    );
    fireEvent.click(
      await within(panel).findByRole("button", { name: "Restore this version" })
    );
    expect(mutation("history:restore")).not.toHaveBeenCalled();

    const confirm = within(panel).getByRole("group", {
      name: "Confirm restore",
    });
    fireEvent.click(within(confirm).getByRole("button", { name: "Restore" }));
    const alert = await within(panel).findByRole("alert");
    expect(alert).toHaveTextContent("Robert is editing a block");
    expect(mutation("history:restore")).toHaveBeenCalledExactlyOnceWith({
      changeSetId: "cs-dana",
    });
  });

  it("returns to the list once the restore lands, where it shows as the person’s change", async () => {
    mutationEffect(
      "history:restore",
      () => {
        changeSets = [
          {
            _id: "cs-new",
            actorParticipantId: ROBERT,
            at: at(55),
            kind: "restore",
            revisionCount: 2,
          },
          ...changeSets,
        ];
        pushBackend();
      },
      "cs-new"
    );
    const panel = await openHistory();
    fireEvent.click(
      within(panel).getByRole("button", { name: /^Edit by Dana/u })
    );
    fireEvent.click(
      await within(panel).findByRole("button", { name: "Restore this version" })
    );
    fireEvent.click(
      within(
        within(panel).getByRole("group", { name: "Confirm restore" })
      ).getByRole("button", { name: "Restore" })
    );

    await within(panel).findByRole("list", { name: "Versions" });
    expect(entryTitles(panel)[0]).toBe("Restore by Robert");
    expect(within(panel).getByRole("status")).toHaveTextContent(
      /^Restored the version from /u
    );
    expect(mutation("history:restore")).toHaveBeenCalledOnce();
  });
});
