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

const signedInAs = (isOwner: boolean) => {
  backend.queries["me:get"] = () => ({
    email: null,
    isOwner,
    name: null,
    signedIn: true,
    userId: "u1",
  });
};

const runnerSeen = (msAgo: number) => {
  backend.queries["runners:list"] = () => [
    {
      _id: "runner1",
      harnesses: [],
      lastHeartbeatAt: Date.now() - msAgo,
      machine: "vm",
      name: "exe-vm",
    },
  ];
};

const setUp = () => {
  resetBackend();
  signedInAs(true);
  runnerSeen(5000);
  backend.queries["templates:list"] = () => [
    {
      _id: "tpl1",
      name: "Design review",
      sections: [
        { heading: "Goals" },
        { guidance: "What could go wrong?", heading: "Risks" },
      ],
    },
  ];
};

describe("new room page", () => {
  beforeEach(setUp);

  it("tells a teammate that only the owner can create rooms", async () => {
    signedInAs(false);
    renderAt("/rooms/new");
    await screen.findByRole("heading", {
      name: /only robert can create rooms/iu,
    });
    expect(
      screen.queryByRole("button", { name: "Create room" })
    ).not.toBeInTheDocument();
  });

  it("asks for the same details as the phone, with the default template chosen", async () => {
    renderAt("/rooms/new");
    const roomName = await screen.findByLabelText("Room name");
    expect(roomName).toHaveValue("");
    expect(screen.getByLabelText("Project folder")).toHaveValue(
      "/home/exedev/Projects/"
    );
    expect(screen.getByText("exe-vm")).toBeInTheDocument();
    const template = screen.getByLabelText("Template");
    expect(template).toHaveDisplayValue("Default");
    expect(
      screen.getByRole("option", { name: "Design review" })
    ).toBeInTheDocument();
  });

  it("creates the room with the chosen template and opens it", async () => {
    mutation("rooms:create").mockResolvedValue("room9");
    const { router } = renderAt("/rooms/new");

    fireEvent.change(await screen.findByLabelText("Room name"), {
      target: { value: "Pricing plan" },
    });
    fireEvent.change(screen.getByLabelText("Project folder"), {
      target: { value: "/home/exedev/Projects/pricing" },
    });
    fireEvent.change(screen.getByLabelText("Template"), {
      target: { value: "tpl1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create room" }));

    expect(mutation("rooms:create")).toHaveBeenCalledWith({
      cwd: "/home/exedev/Projects/pricing",
      name: "Pricing plan",
      runnerId: "runner1",
      templateId: "tpl1",
    });
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/rooms/room9");
    });
  });

  it("sends no template when the default is kept", async () => {
    mutation("rooms:create").mockResolvedValue("room9");
    renderAt("/rooms/new");

    fireEvent.change(await screen.findByLabelText("Room name"), {
      target: { value: "Pricing plan" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create room" }));

    expect(mutation("rooms:create")).toHaveBeenCalledWith({
      cwd: "/home/exedev/Projects/",
      name: "Pricing plan",
      runnerId: "runner1",
    });
  });

  it("says no runner is online and disables Create when the runner has stopped checking in", async () => {
    runnerSeen(60_000);
    renderAt("/rooms/new");

    fireEvent.change(await screen.findByLabelText("Room name"), {
      target: { value: "Pricing plan" },
    });
    expect(screen.getByText("No runner online")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create room" })).toBeDisabled();
  });
});

describe("room list", () => {
  beforeEach(setUp);

  it("offers the owner a new room", async () => {
    backend.queries["rooms:list"] = () => [];
    renderAt("/");
    const link = await screen.findByRole("link", { name: "New room" });
    expect(link).toHaveAttribute("href", "/rooms/new");
  });

  it("offers a teammate no new room", async () => {
    signedInAs(false);
    backend.queries["rooms:list"] = () => [];
    renderAt("/");
    await screen.findByText("No rooms yet");
    expect(
      screen.queryByRole("link", { name: "New room" })
    ).not.toBeInTheDocument();
  });
});
