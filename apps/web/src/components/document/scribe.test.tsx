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
const RUN = "run1";
const TURN = "turn-scribe";

const by = (participantId: string) => ({ kind: "participant", participantId });

const blocks = [
  {
    _id: "h1",
    author: by(ROBERT),
    kind: "heading",
    openThreads: 0,
    order: "a0",
    rev: 3,
    text: "Ideas & notes",
  },
  {
    _id: "b1",
    author: by(CLAUDE),
    kind: "paragraph",
    openThreads: 0,
    order: "a1",
    rev: 3,
    text: "Charge per seat.",
  },
  {
    _id: "b2",
    author: by(DANA),
    kind: "listItem",
    openThreads: 0,
    order: "a2",
    rev: 3,
    text: "Try a free tier",
  },
];

interface Run {
  runId: string;
  participantId: string;
  startedByParticipantId: string;
  startedAt: number;
  endedAt?: number;
  status: "running" | "committed" | "released";
  releaseReason?: string;
  turnId?: string;
  stoppedByParticipantId?: string;
  changeSetId?: string;
}

// The document's lock while a run holds it, and the room's latest run.
let lock: { scribeRunId?: string; scribeLockExpiresAt?: number };
let run: Run | null;
let changeSets: {
  _id: string;
  kind: string;
  actorParticipantId: string;
  at: number;
  revisionCount: number;
  scribeParticipantId?: string;
  scribeStartedByParticipantId?: string;
}[];

// Claude acting as scribe, called in by Dana two minutes and five seconds ago.
const working = () => {
  lock = { scribeLockExpiresAt: Date.now() + 30 * 60_000, scribeRunId: RUN };
  run = {
    participantId: CLAUDE,
    runId: RUN,
    startedAt: Date.now() - 125_000,
    startedByParticipantId: DANA,
    status: "running",
    turnId: TURN,
  };
};

// The run ends: the lock clears and the run records how.
const end = (how: Partial<Run>) => {
  lock = {};
  assert(run);
  run = { ...run, endedAt: Date.now(), ...how };
  pushBackend();
};

const openRoom = async () => {
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
    documentId: "d1",
    rev: 3,
    ...lock,
    blocks,
  });
  backend.queries["threads:list"] = () => ({ open: [], settled: [] });
  backend.queries["scribe:latest"] = () => run;
  backend.queries["history:list"] = paginate(() => changeSets);
  backend.queries["history:version"] = ({ changeSetId }) => ({
    blocks: blocks.map(({ _id, order, kind, text, author }) => ({
      author,
      blockId: _id,
      kind,
      order,
      text,
    })),
    changeSetId,
    rev: 3,
  });
  backend.queries["history:diff"] = () => [];
  renderAt(`/rooms/${ROOM}`);
  return await screen.findByRole("region", { name: "Room document" });
};

const toolbarOf = (text: string) => {
  const block = screen.getByText(text).closest<HTMLElement>("[data-block-id]");
  assert(block);
  return within(block).getByRole("toolbar");
};

const setUp = () => {
  resetBackend();
  window.localStorage.clear();
  lock = {};
  run = null;
  changeSets = [
    {
      _id: "cs-seed",
      actorParticipantId: ROBERT,
      at: Date.now() - 3_600_000,
      kind: "template_seed",
      revisionCount: 3,
    },
  ];
};

const tearDown = () => {
  vi.restoreAllMocks();
};

describe("calling in the scribe", () => {
  beforeEach(setUp);
  afterEach(tearDown);

  it("starts a run with the model the person chooses", async () => {
    await openRoom();
    fireEvent.click(screen.getByRole("button", { name: "Call in the scribe" }));
    const choose = screen.getByRole("group", { name: "Choose the scribe" });
    expect(
      within(choose)
        .getAllByRole("button")
        .map((b) => b.textContent)
    ).toStrictEqual(["Claude", "Pi", "Cancel"]);

    fireEvent.click(within(choose).getByRole("button", { name: "Pi" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("group", { name: "Choose the scribe" })
      ).not.toBeInTheDocument()
    );
    expect(mutation("scribe:begin")).toHaveBeenCalledExactlyOnceWith({
      participantId: PI,
      roomId: ROOM,
    });
  });

  it("shows the refusal naming the person who is editing, and starts nothing", async () => {
    mutation("scribe:begin").mockRejectedValue(
      new Error(
        "[CONVEX M(scribe:begin)] [Request ID: 1] Server Error\nUncaught Error: Dana is editing a block\n    at handler (scribe.ts:1:1)"
      )
    );
    await openRoom();
    fireEvent.click(screen.getByRole("button", { name: "Call in the scribe" }));
    const choose = screen.getByRole("group", { name: "Choose the scribe" });
    fireEvent.click(within(choose).getByRole("button", { name: "Claude" }));

    const alert = await within(choose).findByRole("alert");
    expect(alert).toHaveTextContent(/^Dana is editing a block$/u);
    expect(
      screen.queryByRole("region", { name: "The scribe is working" })
    ).not.toBeInTheDocument();
    expect(
      within(toolbarOf("Charge per seat.")).getByRole("button", {
        name: "Edit",
      })
    ).toBeEnabled();
  });
});

describe("while the scribe works", () => {
  beforeEach(setUp);
  afterEach(tearDown);

  it("shows the banner with the model, who started it and the time so far, and every block’s edit, add, move and delete is disabled", async () => {
    working();
    await openRoom();
    const banner = screen.getByRole("region", {
      name: "The scribe is working",
    });
    expect(banner).toHaveTextContent("The scribe is working");
    expect(banner).toHaveTextContent(/Claude, started by Dana · 2m 0\ds/u);

    for (const text of [
      "Ideas & notes",
      "Charge per seat.",
      "Try a free tier",
    ]) {
      const toolbar = toolbarOf(text);
      for (const name of [
        "Edit",
        "Add below",
        "Move up",
        "Move down",
        "Delete",
      ]) {
        expect(within(toolbar).getByRole("button", { name })).toBeDisabled();
      }
    }
    expect(
      screen.getByRole("button", { name: "Add to Ideas & notes" })
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Call in the scribe" })
    ).toBeDisabled();
  });

  it("Stop cancels the scribe’s turn, and the notice says the document is unchanged", async () => {
    working();
    mutationEffect("messages:cancel", () => {
      end({
        releaseReason: "Cancelled by owner",
        status: "released",
        stoppedByParticipantId: ROBERT,
      });
    });
    await openRoom();
    fireEvent.click(
      within(
        screen.getByRole("region", { name: "The scribe is working" })
      ).getByRole("button", { name: "Stop" })
    );

    const notice = await screen.findByRole("status", {
      name: "Scribe run ended",
    });
    expect(notice).toHaveTextContent(
      "Robert stopped the scribe run. The document is unchanged."
    );
    expect(mutation("messages:cancel")).toHaveBeenCalledExactlyOnceWith({
      turnId: TURN,
    });
    expect(
      screen.queryByRole("region", { name: "The scribe is working" })
    ).not.toBeInTheDocument();
    expect(
      within(toolbarOf("Charge per seat.")).getByRole("button", {
        name: "Edit",
      })
    ).toBeEnabled();

    fireEvent.click(within(notice).getByRole("button", { name: "Dismiss" }));
    expect(
      screen.queryByRole("status", { name: "Scribe run ended" })
    ).not.toBeInTheDocument();
  });

  it("a failed run’s notice gives the reason and says the document is unchanged", async () => {
    working();
    await openRoom();
    end({ releaseReason: "Model overloaded", status: "released" });
    const ended = await screen.findByRole("status", {
      name: "Scribe run ended",
    });
    expect(ended).toHaveTextContent(
      "The scribe run failed: Model overloaded. The document is unchanged."
    );
  });
});

describe("a committed run", () => {
  beforeEach(setUp);
  afterEach(tearDown);

  it("announces the run and opens its history entry, which names the scribe and the person who started it", async () => {
    working();
    await openRoom();
    changeSets = [
      {
        _id: "cs-scribe",
        actorParticipantId: CLAUDE,
        at: Date.now(),
        kind: "scribe_run",
        revisionCount: 6,
        scribeParticipantId: CLAUDE,
        scribeStartedByParticipantId: DANA,
      },
      ...changeSets,
    ];
    end({ changeSetId: "cs-scribe", status: "committed" });

    const notice = await screen.findByRole("status", {
      name: "Scribe run ended",
    });
    expect(notice).toHaveTextContent("Claude finished the scribe run.");
    fireEvent.click(
      within(notice).getByRole("button", { name: "See it in history" })
    );

    const panel = await screen.findByRole("dialog", { name: "History" });
    await within(panel).findByRole("region", {
      name: "Version: Scribe run by Claude, started by Dana",
    });
    fireEvent.click(
      within(panel).getByRole("button", { name: "All versions" })
    );
    const list = within(panel).getByRole("list", { name: "Versions" });
    expect(
      within(list)
        .getAllByRole("listitem")[0]
        ?.querySelector("[data-entry-title]")
    ).toHaveTextContent("Scribe run by Claude, started by Dana");
  });

  it("a run that ended before the document was opened is not announced", async () => {
    run = {
      changeSetId: "cs-scribe",
      endedAt: Date.now() - 300_000,
      participantId: CLAUDE,
      runId: RUN,
      startedAt: Date.now() - 600_000,
      startedByParticipantId: DANA,
      status: "committed",
      turnId: TURN,
    };
    await openRoom();
    expect(
      screen.queryByRole("status", { name: "Scribe run ended" })
    ).not.toBeInTheDocument();
  });
});
