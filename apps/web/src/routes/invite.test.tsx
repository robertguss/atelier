import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { backend, mutation, resetBackend, signOut } from "~/test/backend";
import { renderAt } from "~/test/render";

vi.mock(import("convex/react"), async () => {
  const { convexMock } = await import("~/test/backend");
  return convexMock;
});
vi.mock(import("~/auth/ClerkShell"), async () => {
  const { authMock } = await import("~/test/backend");
  return authMock;
});

const TOKEN = "tok_abc";

const invite = (overrides: Record<string, unknown>) => {
  backend.queries["invites:lookup"] = ({ token }) =>
    token === TOKEN
      ? {
          email: "d***@example.com",
          expiresAt: Date.now() + 86_400_000,
          matches: true,
          roomId: "room1",
          roomName: "Pricing plan",
          status: "pending",
          ...overrides,
        }
      : null;
};

describe("invite page", () => {
  beforeEach(resetBackend);

  it("shows the masked invited address and a sign-out offer when signed in with another email", async () => {
    invite({ matches: false });
    renderAt(`/invite/${TOKEN}`);

    await waitFor(() => {
      expect(screen.getByText(/d\*\*\*@example\.com/u)).toBeInTheDocument();
    });
    expect(screen.getByText(/sam@other\.example/u)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /join/iu })
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /sign out/iu }));
    expect(signOut).toHaveBeenCalledWith();
  });

  it("says an expired invite has expired", async () => {
    invite({ status: "expired" });
    renderAt(`/invite/${TOKEN}`);
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /this invite has expired/iu })
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("button", { name: /join/iu })
    ).not.toBeInTheDocument();
  });

  it("says a revoked invite was revoked", async () => {
    invite({ status: "revoked" });
    renderAt(`/invite/${TOKEN}`);
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /this invite was revoked/iu })
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("button", { name: /join/iu })
    ).not.toBeInTheDocument();
  });

  it("accepts a matching invite and opens the room", async () => {
    invite({});
    mutation("invites:accept").mockResolvedValue({
      ok: true,
      roomId: "room1",
    });
    const { router } = renderAt(`/invite/${TOKEN}`);

    fireEvent.click(
      await screen.findByRole("button", { name: /join pricing plan/iu })
    );

    expect(mutation("invites:accept")).toHaveBeenCalledWith({
      token: TOKEN,
    });
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/rooms/room1");
    });
  });

  it("asks a signed-out visitor to sign in", async () => {
    backend.signedIn = false;
    invite({ matches: false });
    renderAt(`/invite/${TOKEN}`);
    await waitFor(() => {
      expect(screen.getByText("Clerk sign-in form")).toBeInTheDocument();
    });
    expect(screen.getByText(/Pricing plan/u)).toBeInTheDocument();
  });

  it("reveals nothing for an unknown token", async () => {
    invite({});
    renderAt("/invite/someone-elses-guess");
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /invite link isn.t valid/iu })
      ).toBeInTheDocument();
    });
    expect(screen.queryByText(/Pricing plan/u)).not.toBeInTheDocument();
  });
});
