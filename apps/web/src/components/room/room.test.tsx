import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { assert, beforeEach, describe, expect, it, vi } from "vitest";

import {
  action,
  backend,
  mutation,
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
const CODEX = "p-codex";

interface Pane {
  runner: { lastHeartbeatAt: number; offlineAfterMs: number };
  editsEnabled: boolean;
  hasOlder: boolean;
  agents: Record<string, unknown>[];
  messages: Record<string, unknown>[];
  cards: Record<string, unknown>[];
  turns: Record<string, unknown>[];
}

let pane: Pane;

let teamMessages: {
  _id: string;
  at: number;
  authorParticipantId: string;
  body: string;
}[];

const teamMessage = (
  _id: string,
  authorParticipantId: string,
  body: string
) => ({ _id, at: 1000, authorParticipantId, body });

const agent = (
  participantId: string,
  harness: string,
  displayName: string,
  overrides: Record<string, unknown> = {}
) => ({
  activeTurnId: null,
  canRaiseCards: true,
  displayName,
  harness,
  participantId,
  queued: 0,
  status: "idle",
  takesSteer: false,
  ...overrides,
});

const message = (overrides: Record<string, unknown>) => ({
  at: 1000,
  authorParticipantId: DANA,
  body: "Hello",
  cancelReason: null,
  deliveredTurnId: null,
  delivery: "delivered",
  id: "m1",
  maySteer: true,
  toParticipantId: CLAUDE,
  turnId: null,
  ...overrides,
});

const turn = (overrides: Record<string, unknown>) => ({
  at: 2000,
  endedAt: null,
  error: null,
  id: "t1",
  items: [],
  partialText: "",
  participantId: CLAUDE,
  requestedByParticipantIds: [ROBERT],
  startedAt: 2000,
  status: "running",
  stoppedByParticipantId: null,
  waitingOnHandId: null,
  ...overrides,
});

const scopeQuestion = {
  allowFreeText: true,
  header: "Scope",
  id: "scope",
  multiSelect: false,
  options: [
    { label: "Small" },
    { description: "Everything at once", label: "Large" },
  ],
  text: "How big should the plan be?",
};

const card = (overrides: Record<string, unknown>) => ({
  answeredAt: null,
  answeredByParticipantId: null,
  answers: null,
  closeReason: null,
  closedAt: null,
  id: "h1",
  participantId: CLAUDE,
  questions: [scopeQuestion],
  raisedAt: 3000,
  status: "raised",
  turnId: "t1",
  via: null,
  ...overrides,
});

const room = (access: "owner" | "member" = "owner") => {
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
      { _id: CODEX, displayName: "Codex", harness: "codex", kind: "harness" },
    ],
    room: { _id: ROOM, editsEnabled: pane.editsEnabled, name: "Pricing plan" },
  });
  backend.queries["agent:pane"] = () => pane;
  backend.queries["team:list"] = () => teamMessages;
  backend.queries["members:list"] = () => ({ invites: [], members: [] });
  backend.queries["documents:get"] = () => ({
    blocks: [],
    documentId: "d1",
    rev: 1,
  });
};

// What a room query does once the caller is no longer a member.
const notAMember = () => {
  throw new Error("Not a member of this room");
};

const showTeam = () => {
  fireEvent.click(screen.getByRole("button", { name: /^Show team chat/u }));
};

const openRoom = async (access: "owner" | "member" = "owner") => {
  room(access);
  const rendered = renderAt(`/rooms/${ROOM}`);
  await screen.findByRole("heading", { name: "Pricing plan" });
  return rendered;
};

describe("room screen", () => {
  beforeEach(() => {
    resetBackend();
    window.localStorage.clear();
    teamMessages = [];
    pane = {
      agents: [
        agent(CLAUDE, "claude", "Claude"),
        agent(CODEX, "codex", "Codex", { canRaiseCards: false }),
      ],
      cards: [],
      editsEnabled: false,
      hasOlder: false,
      messages: [],
      runner: { lastHeartbeatAt: Date.now(), offlineAfterMs: 45_000 },
      turns: [],
    };
  });

  describe("layout", () => {
    it("opens on the document, with the agent pane expanded and team chat collapsed the first time", async () => {
      await openRoom();
      expect(screen.getByRole("main")).toContainElement(
        screen.getByRole("region", { name: "Room document" })
      );
      expect(
        screen.getByRole("region", { name: "Agents" })
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("region", { name: "Team chat" })
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Show team chat" })
      ).toBeInTheDocument();
    });

    it("reopens the side panels as they were last left", async () => {
      const first = await openRoom();
      fireEvent.click(screen.getByRole("button", { name: "Hide agents" }));
      showTeam();
      first.unmount();

      await openRoom();
      expect(
        screen.queryByRole("region", { name: "Agents" })
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Show agents" })
      ).toBeInTheDocument();
      expect(
        screen.getByRole("region", { name: "Team chat" })
      ).toBeInTheDocument();
      expect(
        screen.getByRole("region", { name: "Room document" })
      ).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Show agents" }));
      expect(
        screen.getByRole("textbox", { name: "To Claude" })
      ).toBeInTheDocument();
    });

    it("flags a pending question card on the collapsed agent pane", async () => {
      pane.agents = [
        agent(CLAUDE, "claude", "Claude", {
          activeTurnId: "t1",
          status: "waiting",
        }),
      ];
      pane.turns = [turn({ waitingOnHandId: "h1" })];
      pane.cards = [card({})];
      await openRoom();
      fireEvent.click(screen.getByRole("button", { name: "Hide agents" }));
      const handle = screen.getByRole("button", {
        name: "Show agents: 1 question",
      });
      expect(within(handle).getByText("1 question")).toBeInTheDocument();
    });

    it("flags a running turn on the collapsed agent pane", async () => {
      pane.agents = [
        agent(CLAUDE, "claude", "Claude", {
          activeTurnId: "t1",
          status: "running",
        }),
      ];
      pane.turns = [turn({})];
      await openRoom();
      fireEvent.click(screen.getByRole("button", { name: "Hide agents" }));
      expect(
        screen.getByRole("button", { name: "Show agents: Working" })
      ).toBeInTheDocument();
    });

    it("counts unread team messages on the collapsed team chat, leaving out the person's own", async () => {
      teamMessages = [
        teamMessage("tm1", DANA, "Too big?"),
        teamMessage("tm2", ROBERT, "Maybe"),
        teamMessage("tm3", DANA, "Cut it"),
      ];
      await openRoom();
      expect(
        screen.getByRole("button", { name: "Show team chat: 2 unread" })
      ).toBeInTheDocument();

      showTeam();
      expect(screen.getByText("Cut it")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Hide team chat" }));
      expect(
        screen.getByRole("button", { name: "Show team chat" })
      ).toBeInTheDocument();

      teamMessages = [...teamMessages, teamMessage("tm4", DANA, "Agreed then")];
      act(() => {
        pushBackend();
      });
      expect(
        screen.getByRole("button", { name: "Show team chat: 1 unread" })
      ).toBeInTheDocument();
    });
  });

  describe("composers", () => {
    it("labels each composer by its audience", async () => {
      await openRoom();
      showTeam();
      expect(
        screen.getByRole("textbox", { name: "To Claude" })
      ).toBeInTheDocument();
      expect(
        screen.getByRole("textbox", { name: "To team only" })
      ).toBeInTheDocument();
    });

    it("sends Enter in the team composer to the team only and keeps focus there", async () => {
      await openRoom();
      showTeam();
      const team = screen.getByRole("textbox", { name: "To team only" });
      team.focus();
      fireEvent.change(team, {
        target: { value: "between us, this plan is too big" },
      });
      fireEvent.keyDown(team, { key: "Enter" });

      await waitFor(() => {
        expect(mutation("team:post")).toHaveBeenCalledWith({
          body: "between us, this plan is too big",
          roomId: ROOM,
        });
      });
      expect(mutation("messages:send")).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(team);
    });

    it("sends Enter in the agent composer to the target agent, and Shift+Enter adds a line", async () => {
      await openRoom();
      const toClaude = screen.getByRole("textbox", { name: "To Claude" });
      toClaude.focus();
      fireEvent.change(toClaude, { target: { value: "Draft the plan" } });
      fireEvent.keyDown(toClaude, { key: "Enter", shiftKey: true });
      expect(mutation("messages:send")).not.toHaveBeenCalled();

      fireEvent.keyDown(toClaude, { key: "Enter" });
      await waitFor(() => {
        expect(mutation("messages:send")).toHaveBeenCalledWith({
          body: "Draft the plan",
          roomId: ROOM,
          toParticipantId: CLAUDE,
        });
      });
      expect(mutation("team:post")).not.toHaveBeenCalled();
    });

    it("defaults the agent composer to the agent waiting on an open card", async () => {
      pane.turns = [turn({ participantId: CODEX })];
      pane.cards = [card({ participantId: CODEX })];
      await openRoom();
      expect(
        screen.getByRole("textbox", { name: "To Codex" })
      ).toBeInTheDocument();
    });

    it("switches the target when the person picks another agent", async () => {
      await openRoom();
      fireEvent.click(screen.getByRole("button", { name: "Codex" }));
      expect(
        screen.getByRole("textbox", { name: "To Codex" })
      ).toBeInTheDocument();
    });

    it('offers "Send and steer now" while the target agent works, and sends the message as a steer', async () => {
      pane.agents = [
        agent(CLAUDE, "claude", "Claude", {
          activeTurnId: "t1",
          status: "running",
          takesSteer: true,
        }),
      ];
      pane.turns = [turn({})];
      await openRoom();

      const toClaude = screen.getByRole("textbox", { name: "To Claude" });
      fireEvent.change(toClaude, { target: { value: "Stop, keep it short" } });
      fireEvent.click(
        screen.getByRole("button", { name: "Send and steer now" })
      );

      await waitFor(() => {
        expect(mutation("messages:send")).toHaveBeenCalledWith({
          body: "Stop, keep it short",
          roomId: ROOM,
          steer: true,
          toParticipantId: CLAUDE,
        });
      });
      expect(mutation("messages:send")).toHaveBeenCalledOnce();
      expect(mutation("agent:steer")).not.toHaveBeenCalled();
    });

    it("keeps the target while the person is typing, even when another agent raises a card", async () => {
      await openRoom();
      const toClaude = screen.getByRole("textbox", { name: "To Claude" });
      toClaude.focus();
      fireEvent.change(toClaude, { target: { value: "Keep the plan small" } });

      pane.agents = [
        agent(CLAUDE, "claude", "Claude"),
        agent(CODEX, "codex", "Codex", {
          activeTurnId: "t1",
          status: "waiting",
        }),
      ];
      pane.turns = [turn({ participantId: CODEX, waitingOnHandId: "h1" })];
      pane.cards = [card({ participantId: CODEX })];
      act(() => {
        pushBackend();
      });
      await screen.findByRole("group", { name: /Codex asks/u });

      const composer = screen.getByRole("textbox", { name: "To Claude" });
      expect(composer).toHaveValue("Keep the plan small");
      fireEvent.keyDown(composer, { key: "Enter" });
      await waitFor(() => {
        expect(mutation("messages:send")).toHaveBeenCalledWith({
          body: "Keep the plan small",
          roomId: ROOM,
          toParticipantId: CLAUDE,
        });
      });
    });

    it("keeps text typed while a message is still sending", async () => {
      const sending: { finish?: () => void } = {};
      // oxlint-disable-next-line promise/avoid-new -- The test holds the send open and settles it by hand.
      const sent = new Promise<null>((resolve) => {
        sending.finish = () => {
          resolve(null);
        };
      });
      mutation("messages:send").mockReturnValue(sent);
      await openRoom();
      const toClaude = screen.getByRole("textbox", { name: "To Claude" });
      fireEvent.change(toClaude, { target: { value: "Draft the plan" } });
      fireEvent.keyDown(toClaude, { key: "Enter" });
      await waitFor(() => {
        expect(mutation("messages:send")).toHaveBeenCalledOnce();
      });

      fireEvent.change(toClaude, {
        target: { value: "Draft the plan. Also list the risks" },
      });
      await act(async () => {
        sending.finish?.();
        await sent;
      });
      expect(screen.getByRole("textbox", { name: "To Claude" })).toHaveValue(
        "Draft the plan. Also list the risks"
      );
    });

    it('offers only "Send" while the target agent works on a turn that takes no steer', async () => {
      pane.agents = [
        agent(CLAUDE, "claude", "Claude", {
          activeTurnId: "t1",
          status: "running",
        }),
      ];
      pane.turns = [turn({})];
      await openRoom();
      expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Send and steer now" })
      ).not.toBeInTheDocument();
    });

    it("pins the pane to the newest message after a send from mid-history", async () => {
      pane.turns = [turn({ partialText: "History.", status: "done" })];
      await openRoom();
      const scroller = screen
        .getByRole("region", { name: "Agents" })
        .querySelector("ol")?.parentElement;
      assert(scroller);
      Object.defineProperty(scroller, "scrollHeight", { value: 1000 });
      Object.defineProperty(scroller, "clientHeight", { value: 400 });
      Object.defineProperty(scroller, "scrollTop", {
        configurable: true,
        value: 100,
        writable: true,
      });
      fireEvent.scroll(scroller);

      fireEvent.change(screen.getByRole("textbox", { name: "To Claude" }), {
        target: { value: "One more thing" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => {
        expect(mutation("messages:send")).toHaveBeenCalledOnce();
      });
      await waitFor(() => {
        expect(scroller.scrollTop).toBe(1000);
      });
    });

    it('offers only "Send" while the target agent is idle', async () => {
      await openRoom();
      expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Send and steer now" })
      ).not.toBeInTheDocument();
    });
  });

  describe("question cards", () => {
    it("answers an open card with the chosen option without moving focus to the agent composer", async () => {
      pane.agents = [
        agent(CLAUDE, "claude", "Claude", {
          activeTurnId: "t1",
          status: "waiting",
        }),
      ];
      pane.turns = [turn({ waitingOnHandId: "h1" })];
      pane.cards = [card({})];
      await openRoom();

      const open = screen.getByRole("group", { name: /Claude asks/u });
      expect(
        within(open).getByText("How big should the plan be?")
      ).toBeInTheDocument();
      const large = within(open).getByRole("button", { name: /Large/u });
      large.focus();
      fireEvent.click(large);
      fireEvent.click(within(open).getByRole("button", { name: "Answer" }));

      await waitFor(() => {
        expect(mutation("hands:answer")).toHaveBeenCalledWith({
          answers: [{ labels: ["Large"], questionId: "scope" }],
          handId: "h1",
        });
      });
      expect(document.activeElement).not.toBe(
        screen.getByRole("textbox", { name: "To Claude" })
      );
    });

    it("shows who answered a card and what they chose", async () => {
      pane.turns = [turn({ status: "done" })];
      pane.cards = [
        card({
          answeredByParticipantId: DANA,
          answers: [{ labels: ["Large"], questionId: "scope" }],
          status: "answered",
          via: "card",
        }),
      ];
      await openRoom();
      expect(screen.getByText("Answered by Dana")).toBeInTheDocument();
      expect(screen.getByText("Large")).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Answer" })
      ).not.toBeInTheDocument();
    });

    it("shows a card answered in chat", async () => {
      pane.turns = [turn({ status: "done" })];
      pane.cards = [
        card({
          answeredByParticipantId: DANA,
          answers: [
            {
              freeText: "go with option B but keep it short",
              labels: [],
              questionId: "scope",
            },
          ],
          status: "answered",
          via: "chat",
        }),
      ];
      await openRoom();
      expect(screen.getByText("Answered in chat by Dana")).toBeInTheDocument();
      expect(
        screen.getAllByText("go with option B but keep it short").length
      ).toBeGreaterThan(0);
    });

    it("shows a card cancelled because the turn was stopped", async () => {
      pane.turns = [
        turn({ error: "Cancelled by Dana", status: "interrupted" }),
      ];
      pane.cards = [
        card({ closeReason: "Cancelled by Dana", status: "cancelled" }),
      ];
      await openRoom();
      expect(
        screen.getByText(/Cancelled: the turn was stopped/u)
      ).toBeInTheDocument();
    });

    it("offers to send a late answer to an expired card as a message", async () => {
      pane.turns = [turn({ status: "done" })];
      pane.cards = [
        card({ closeReason: "No answer within 2 hours", status: "expired" }),
      ];
      await openRoom();
      expect(screen.getByText(/Expired with no decision/u)).toBeInTheDocument();

      fireEvent.click(
        screen.getByRole("button", { name: "Send a late answer as a message" })
      );
      const late = screen.getByRole("textbox", {
        name: "Late answer to Claude",
      });
      fireEvent.change(late, { target: { value: "Small, please" } });
      fireEvent.click(screen.getByRole("button", { name: "Send late answer" }));
      await waitFor(() => {
        expect(mutation("messages:send")).toHaveBeenCalledWith({
          body: "Small, please",
          roomId: ROOM,
          toParticipantId: CLAUDE,
        });
      });
    });

    it("marks an agent that can't raise question cards", async () => {
      await openRoom();
      expect(
        screen.getByText("Codex can't raise question cards")
      ).toBeInTheDocument();
      expect(
        screen.queryByText("Claude can't raise question cards")
      ).not.toBeInTheDocument();
    });
  });

  describe("queue, delivery and stopping", () => {
    it("steers a queued message on request", async () => {
      pane.agents = [
        agent(CLAUDE, "claude", "Claude", {
          activeTurnId: "t1",
          queued: 1,
          status: "running",
          takesSteer: true,
        }),
      ];
      pane.turns = [turn({})];
      pane.messages = [
        message({
          at: 3000,
          body: "Use the old pricing",
          delivery: "queued",
          id: "m-q",
        }),
      ];
      await openRoom();

      const queue = screen.getByRole("list", { name: "Queued messages" });
      expect(
        within(queue).getByText("Use the old pricing")
      ).toBeInTheDocument();
      fireEvent.click(within(queue).getByRole("button", { name: "Steer now" }));
      expect(mutation("agent:steer")).toHaveBeenCalledWith({
        messageId: "m-q",
      });
    });

    it("offers Steer now only for a message that may steer, while the turn takes steers", async () => {
      pane.agents = [
        agent(CLAUDE, "claude", "Claude", {
          activeTurnId: "t1",
          queued: 2,
          status: "running",
          takesSteer: true,
        }),
      ];
      pane.turns = [turn({})];
      pane.messages = [
        message({
          at: 3000,
          body: "Ordinary",
          delivery: "queued",
          id: "m-a",
        }),
        message({
          at: 3100,
          body: "Follow-up",
          delivery: "queued",
          id: "m-b",
          maySteer: false,
        }),
      ];
      await openRoom();
      const queue = screen.getByRole("list", { name: "Queued messages" });
      expect(
        within(queue).getAllByRole("button", { name: "Steer now" })
      ).toHaveLength(1);

      pane.agents = [
        agent(CLAUDE, "claude", "Claude", {
          activeTurnId: "t1",
          queued: 2,
          status: "running",
        }),
      ];
      act(() => {
        pushBackend();
      });
      await waitFor(() => {
        expect(
          screen.queryByRole("button", { name: "Steer now" })
        ).not.toBeInTheDocument();
      });
    });

    it("shows a steered message inside its turn, before the answer", async () => {
      pane.turns = [
        turn({ partialText: "Looking at the files.", status: "done" }),
      ];
      pane.messages = [
        message({
          at: 2500,
          body: "STEERED",
          deliveredTurnId: "t1",
          delivery: "steered",
          id: "m-s",
        }),
        message({
          at: 9000,
          authorParticipantId: CLAUDE,
          body: "Here is the plan.",
          delivery: null,
          id: "m-r",
          toParticipantId: null,
          turnId: "t1",
        }),
      ];
      await openRoom();
      const article = screen.getByRole("article", { name: "Claude's turn" });
      const text = article.textContent ?? "";
      expect(text).toContain("Steered into the running turn");
      expect(text.indexOf("Looking at the files.")).toBeLessThan(
        text.indexOf("STEERED")
      );
      expect(text.indexOf("STEERED")).toBeLessThan(
        text.indexOf("Here is the plan.")
      );
    });

    it("shows a rejected steer back in the queue", async () => {
      pane.agents = [
        agent(CLAUDE, "claude", "Claude", {
          activeTurnId: "t1",
          queued: 1,
          status: "running",
          takesSteer: true,
        }),
      ];
      pane.turns = [turn({})];
      pane.messages = [
        message({
          at: 3000,
          body: "Use the old pricing",
          delivery: "steering",
          id: "m-q",
        }),
      ];
      await openRoom();
      expect(screen.getByText(/Steering…/u)).toBeInTheDocument();

      pane.messages = [
        message({
          at: 3000,
          body: "Use the old pricing",
          delivery: "queued",
          id: "m-q",
        }),
      ];
      act(() => {
        pushBackend();
      });
      await waitFor(() => {
        expect(
          screen.getByText(/Couldn't steer into the running turn/u)
        ).toBeInTheDocument();
      });
      expect(
        screen.getByRole("button", { name: "Steer now" })
      ).toBeInTheDocument();
    });

    it("says why a message was never delivered", async () => {
      pane.messages = [
        message({
          body: "From a removed member",
          cancelReason: "removed",
          delivery: "cancelled",
          id: "m-a",
        }),
        message({
          at: 1500,
          body: "Sent while offline",
          cancelReason: "runner offline",
          delivery: "cancelled",
          id: "m-b",
        }),
      ];
      await openRoom();
      expect(
        screen.getByText(/Not delivered: its author was removed from the room/u)
      ).toBeInTheDocument();
      expect(
        screen.getByText(/Not delivered: the agents' machine was offline/u)
      ).toBeInTheDocument();
    });

    it("shows who wrote each message and to which agent", async () => {
      pane.messages = [message({ body: "Draft the plan" })];
      await openRoom();
      expect(screen.getByText("Dana → Claude")).toBeInTheDocument();
    });

    it("stops a running turn", async () => {
      pane.agents = [
        agent(CLAUDE, "claude", "Claude", {
          activeTurnId: "t1",
          status: "running",
        }),
      ];
      pane.turns = [turn({ partialText: "Working on **it**" })];
      await openRoom();
      expect(screen.getByText("it")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Stop Claude" }));
      expect(mutation("messages:cancel")).toHaveBeenCalledWith({
        turnId: "t1",
      });
    });

    it("streams a running turn's text and tool activity from the live query", async () => {
      pane.agents = [
        agent(CLAUDE, "claude", "Claude", {
          activeTurnId: "t1",
          status: "running",
        }),
      ];
      pane.turns = [turn({})];
      backend.queries["agent:live"] = () => [
        {
          id: "t1",
          items: [{ name: "Grep", ok: null, summary: "price" }],
          partialText: "Checking **pricing**",
        },
      ];
      await openRoom();
      expect(screen.getByText("pricing")).toBeInTheDocument();
      // A running turn shows its tool activity open.
      expect(screen.getByText("price")).toBeInTheDocument();
    });

    it("asks for a longer history from Show earlier", async () => {
      const limits: unknown[] = [];
      pane.hasOlder = true;
      pane.turns = [turn({ partialText: "Recent work.", status: "done" })];
      await openRoom();
      const handler = backend.queries["agent:pane"];
      assert(handler);
      backend.queries["agent:pane"] = (args) => {
        limits.push(args.limit);
        return handler(args);
      };
      fireEvent.click(screen.getByRole("button", { name: "Show earlier" }));
      await waitFor(() => {
        expect(limits).toContain(80);
      });
      expect(screen.getByText("Recent work.")).toBeInTheDocument();
    });

    it("keeps a finished turn's streamed text and tool activity next to its answer", async () => {
      pane.turns = [
        turn({
          items: [{ name: "Read", ok: true, summary: "docs/plan.md" }],
          partialText: "Looking at the files first.",
          status: "done",
        }),
      ];
      pane.messages = [
        message({
          at: 9000,
          authorParticipantId: CLAUDE,
          body: "Here is the plan.",
          delivery: null,
          id: "m-r",
          toParticipantId: null,
          turnId: "t1",
        }),
      ];
      await openRoom();
      expect(
        screen.getByText("Looking at the files first.")
      ).toBeInTheDocument();
      expect(screen.getByText("Here is the plan.")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /1 tool call/u }));
      expect(screen.getByText("docs/plan.md")).toBeInTheDocument();
    });
  });

  describe("room header and access", () => {
    it("shows the offline banner and refuses to send to agents when the runner is silent", async () => {
      pane.runner.lastHeartbeatAt = Date.now() - 60_000;
      await openRoom();
      expect(screen.getByRole("alert")).toHaveTextContent(
        /machine is offline/u
      );
      expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    });

    it("lets the owner flip the edit switch", async () => {
      await openRoom("owner");
      fireEvent.click(
        screen.getByRole("switch", { name: /agents may edit files/iu })
      );
      expect(mutation("rooms:setEditsEnabled")).toHaveBeenCalledWith({
        on: true,
        roomId: ROOM,
      });
    });

    it("shows members the edit switch read-only and no members sheet", async () => {
      pane.editsEnabled = true;
      await openRoom("member");
      const editSwitch = screen.getByRole("switch", {
        name: /agents may edit files/iu,
      });
      expect(editSwitch).toBeChecked();
      expect(editSwitch).toHaveAttribute("aria-disabled", "true");
      expect(
        screen.queryByRole("button", { name: "Members" })
      ).not.toBeInTheDocument();
    });

    it("lets the owner invite by email and shows the link to share", async () => {
      action("invites:create").mockResolvedValue({
        emailed: true,
        inviteId: "i1",
        url: "https://atelier.example/invite/tok",
      });
      await openRoom("owner");
      fireEvent.click(screen.getByRole("button", { name: "Members" }));
      const email = await screen.findByRole("textbox", { name: "Email" });
      fireEvent.change(email, { target: { value: "dana@example.com" } });
      fireEvent.click(screen.getByRole("button", { name: "Invite" }));
      await waitFor(() => {
        expect(
          screen.getByText("https://atelier.example/invite/tok")
        ).toBeInTheDocument();
      });
      expect(action("invites:create")).toHaveBeenCalledWith({
        email: "dana@example.com",
        roomId: ROOM,
      });
    });

    it("keeps the one-time invite link after the members sheet is closed and reopened", async () => {
      action("invites:create").mockResolvedValue({
        emailed: false,
        inviteId: "i1",
        url: "https://atelier.example/invite/tok",
      });
      await openRoom("owner");
      fireEvent.click(screen.getByRole("button", { name: "Members" }));
      fireEvent.change(await screen.findByRole("textbox", { name: "Email" }), {
        target: { value: "dana@example.com" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Invite" }));
      await waitFor(() => {
        expect(
          screen.getByText("https://atelier.example/invite/tok")
        ).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      await waitFor(() =>
        expect(
          screen.queryByRole("textbox", { name: "Email" })
        ).not.toBeInTheDocument()
      );
      fireEvent.click(screen.getByRole("button", { name: "Members" }));
      await waitFor(() => {
        expect(
          screen.getByText("https://atelier.example/invite/tok")
        ).toBeInTheDocument();
      });
    });

    it("swaps a removed member's open room for the no-access page", async () => {
      await openRoom("member");
      backend.queries["rooms:access"] = () => "removed";
      backend.queries["agent:pane"] = notAMember;
      backend.queries["team:list"] = notAMember;
      backend.queries["rooms:get"] = notAMember;
      act(() => {
        pushBackend();
      });
      await waitFor(() => {
        expect(
          screen.getByRole("heading", {
            name: "You no longer have access",
          })
        ).toBeInTheDocument();
      });
    });
  });
});
