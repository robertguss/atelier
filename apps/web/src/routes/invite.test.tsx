import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { backend, resetBackend, signOut } from "~/test/backend";
import { renderAt } from "~/test/render";

vi.mock(
  "convex/react",
  async () => (await import("~/test/backend")).convexMock
);
vi.mock(
  "~/auth/ClerkShell",
  async () => (await import("~/test/backend")).authMock
);

const TOKEN = "tok_abc";

function invite(overrides: Record<string, unknown>) {
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
}

beforeEach(resetBackend);

describe("invite page", () => {
  it("shows the masked invited address and a sign-out offer when signed in with another email", async () => {
    invite({ matches: false });
    renderAt(`/invite/${TOKEN}`);

    await expect(
      screen.findByText(/d\*\*\*@example\.com/)
    ).resolves.toBeInTheDocument();
    expect(screen.getByText(/sam@other\.example/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /join/i })
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));
    expect(signOut).toHaveBeenCalledWith();
  });

  it("says an expired invite has expired", async () => {
    invite({ status: "expired" });
    renderAt(`/invite/${TOKEN}`);
    await expect(
      screen.findByRole("heading", { name: /this invite has expired/i })
    ).resolves.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /join/i })
    ).not.toBeInTheDocument();
  });

  it("says a revoked invite was revoked", async () => {
    invite({ status: "revoked" });
    renderAt(`/invite/${TOKEN}`);
    await expect(
      screen.findByRole("heading", { name: /this invite was revoked/i })
    ).resolves.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /join/i })
    ).not.toBeInTheDocument();
  });

  it("accepts a matching invite and opens the room", async () => {
    invite({});
    backend.mutations["invites:accept"] = vi.fn(async () => ({
      ok: true,
      roomId: "room1",
    }));
    const { router } = renderAt(`/invite/${TOKEN}`);

    fireEvent.click(
      await screen.findByRole("button", { name: /join pricing plan/i })
    );

    expect(backend.mutations["invites:accept"]).toHaveBeenCalledWith({
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
    await expect(
      screen.findByText("Clerk sign-in form")
    ).resolves.toBeInTheDocument();
    expect(screen.getByText(/Pricing plan/)).toBeInTheDocument();
  });

  it("reveals nothing for an unknown token", async () => {
    invite({});
    renderAt("/invite/someone-elses-guess");
    await expect(
      screen.findByRole("heading", { name: /invite link isn.t valid/i })
    ).resolves.toBeInTheDocument();
    expect(screen.queryByText(/Pricing plan/)).not.toBeInTheDocument();
  });
});
