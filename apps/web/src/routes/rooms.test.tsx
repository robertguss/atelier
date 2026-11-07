import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { backend, mutation, resetBackend } from "~/test/backend";
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
const notMember = () => {
  throw new Error("Not a member of this room");
};

const member = (acceptedVersion: number | null) => {
  backend.queries["rooms:access"] = () => "member";
  backend.queries["members:notice"] = () => ({
    acceptedVersion,
    currentVersion: 2,
  });
  backend.queries["rooms:get"] = () => ({
    participants: [],
    room: { _id: ROOM, name: "Pricing plan" },
  });
};

describe("room page", () => {
  beforeEach(resetBackend);

  it("shows the join notice before the room and stores the accepted version", async () => {
    member(null);
    renderAt(`/rooms/${ROOM}`);

    await waitFor(() => {
      expect(screen.getByText(/recorded permanently/iu)).toBeInTheDocument();
    });
    expect(screen.getByText(/run on Robert.s machine/iu)).toBeInTheDocument();
    expect(
      screen.getByText(/files outside the room.s folder/iu)
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /room document is shared with the agents and kept permanently/iu
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Pricing plan" })
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /enter the room/iu }));
    expect(mutation("members:acceptNotice")).toHaveBeenCalledWith({
      roomId: ROOM,
      version: 2,
    });
  });

  it("opens the room once the current notice is accepted", async () => {
    member(2);
    renderAt(`/rooms/${ROOM}`);
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Pricing plan" })
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByText(/recorded permanently/iu)
    ).not.toBeInTheDocument();
  });

  it("asks a teammate who accepted the first notice to accept the one about the document before entering", async () => {
    member(1);
    renderAt(`/rooms/${ROOM}`);
    await waitFor(() => {
      expect(screen.getByText(/the notice has changed/iu)).toBeInTheDocument();
    });
    expect(
      screen.getByText(
        /room document is shared with the agents and kept permanently/iu
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Pricing plan" })
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /enter the room/iu }));
    expect(mutation("members:acceptNotice")).toHaveBeenCalledWith({
      roomId: ROOM,
      version: 2,
    });
  });

  it("tells a non-member they don't have access instead of failing", async () => {
    backend.queries["rooms:access"] = () => "none";
    backend.queries["members:notice"] = notMember;
    backend.queries["rooms:get"] = notMember;
    renderAt(`/rooms/${ROOM}`);
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "You don't have access" })
      ).toBeInTheDocument();
    });
  });

  it("tells a removed member they no longer have access", async () => {
    backend.queries["rooms:access"] = () => "removed";
    backend.queries["members:notice"] = notMember;
    backend.queries["rooms:get"] = notMember;
    renderAt(`/rooms/${ROOM}`);
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "You no longer have access" })
      ).toBeInTheDocument();
    });
  });
});
