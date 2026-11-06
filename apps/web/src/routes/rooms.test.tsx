import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { backend, resetBackend } from "~/test/backend";
import { renderAt } from "~/test/render";

vi.mock(
  "convex/react",
  async () => (await import("~/test/backend")).convexMock
);
vi.mock(
  "~/auth/ClerkShell",
  async () => (await import("~/test/backend")).authMock
);

const ROOM = "room1";
const notMember = () => {
  throw new Error("Not a member of this room");
};

function member(acceptedVersion: number | null) {
  backend.queries["rooms:access"] = () => "member";
  backend.queries["members:notice"] = () => ({
    acceptedVersion,
    currentVersion: 2,
  });
  backend.queries["rooms:get"] = () => ({
    participants: [],
    room: { _id: ROOM, name: "Pricing plan" },
  });
}

beforeEach(resetBackend);

describe("room page", () => {
  it("shows the join notice before the room and stores the accepted version", async () => {
    member(null);
    renderAt(`/rooms/${ROOM}`);

    await expect(
      screen.findByText(/recorded permanently/i)
    ).resolves.toBeInTheDocument();
    expect(screen.getByText(/run on Robert.s machine/i)).toBeInTheDocument();
    expect(
      screen.getByText(/files outside the room.s folder/i)
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Pricing plan" })
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /enter the room/i }));
    expect(backend.mutations["members:acceptNotice"]).toHaveBeenCalledWith({
      roomId: ROOM,
      version: 2,
    });
  });

  it("opens the room once the current notice is accepted", async () => {
    member(2);
    renderAt(`/rooms/${ROOM}`);
    await expect(
      screen.findByRole("heading", { name: "Pricing plan" })
    ).resolves.toBeInTheDocument();
    expect(screen.queryByText(/recorded permanently/i)).not.toBeInTheDocument();
  });

  it("asks again when the stored notice version is older", async () => {
    member(1);
    renderAt(`/rooms/${ROOM}`);
    await expect(
      screen.findByText(/the notice has changed/i)
    ).resolves.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Pricing plan" })
    ).not.toBeInTheDocument();
  });

  it("tells a non-member they don't have access instead of failing", async () => {
    backend.queries["rooms:access"] = () => "none";
    backend.queries["members:notice"] = notMember;
    backend.queries["rooms:get"] = notMember;
    renderAt(`/rooms/${ROOM}`);
    await expect(
      screen.findByRole("heading", { name: "You don't have access" })
    ).resolves.toBeInTheDocument();
  });

  it("tells a removed member they no longer have access", async () => {
    backend.queries["rooms:access"] = () => "removed";
    backend.queries["members:notice"] = notMember;
    backend.queries["rooms:get"] = notMember;
    renderAt(`/rooms/${ROOM}`);
    await expect(
      screen.findByRole("heading", { name: "You no longer have access" })
    ).resolves.toBeInTheDocument();
  });
});
