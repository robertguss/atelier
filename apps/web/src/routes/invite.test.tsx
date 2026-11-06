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
          roomId: "room1",
          roomName: "Pricing plan",
          email: "d***@example.com",
          status: "pending",
          matches: true,
          expiresAt: Date.now() + 86_400_000,
          ...overrides,
        }
      : null;
}

beforeEach(resetBackend);

describe("invite page", () => {
  it("shows the masked invited address and a sign-out offer when signed in with another email", async () => {
    invite({ matches: false });
    renderAt(`/invite/${TOKEN}`);

    expect(await screen.findByText(/d\*\*\*@example\.com/)).toBeInTheDocument();
    expect(screen.getByText(/sam@other\.example/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /join/i })
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));
    expect(signOut).toHaveBeenCalled();
  });

  it("says an expired invite has expired", async () => {
    invite({ status: "expired" });
    renderAt(`/invite/${TOKEN}`);
    expect(
      await screen.findByRole("heading", { name: /this invite has expired/i })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /join/i })
    ).not.toBeInTheDocument();
  });

  it("says a revoked invite was revoked", async () => {
    invite({ status: "revoked" });
    renderAt(`/invite/${TOKEN}`);
    expect(
      await screen.findByRole("heading", { name: /this invite was revoked/i })
    ).toBeInTheDocument();
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
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/rooms/room1")
    );
  });

  it("asks a signed-out visitor to sign in", async () => {
    backend.signedIn = false;
    invite({ matches: false });
    renderAt(`/invite/${TOKEN}`);
    expect(await screen.findByText("Clerk sign-in form")).toBeInTheDocument();
    expect(screen.getByText(/Pricing plan/)).toBeInTheDocument();
  });

  it("reveals nothing for an unknown token", async () => {
    invite({});
    renderAt("/invite/someone-elses-guess");
    expect(
      await screen.findByRole("heading", { name: /invite link isn.t valid/i })
    ).toBeInTheDocument();
    expect(screen.queryByText(/Pricing plan/)).not.toBeInTheDocument();
  });
});
