import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { assert, beforeEach, describe, expect, it, vi } from "vitest";

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

const setUp = () => {
  resetBackend();
  signedInAs(true);
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

const section = (index: number) => {
  const group = screen.getAllByRole("group", { name: /^Section /u }).at(index);
  assert(group);
  return within(group);
};

describe("templates page", () => {
  beforeEach(setUp);

  it("tells a teammate that only the owner can write templates", async () => {
    signedInAs(false);
    renderAt("/templates");
    await screen.findByRole("heading", {
      name: /only robert can write templates/iu,
    });
    expect(screen.queryByText("Design review")).not.toBeInTheDocument();
  });

  it("lists Robert's templates with their headings", async () => {
    renderAt("/templates");
    await screen.findByText("Design review");
    expect(screen.getByText("Goals · Risks")).toBeInTheDocument();
  });

  it("creates a template from headings and guidance", async () => {
    renderAt("/templates");
    fireEvent.click(
      await screen.findByRole("button", { name: "New template" })
    );

    fireEvent.change(screen.getByLabelText("Template name"), {
      target: { value: "Retro" },
    });
    fireEvent.change(section(0).getByLabelText("Heading"), {
      target: { value: "What went well" },
    });
    fireEvent.change(section(0).getByLabelText("Guidance"), {
      target: { value: "Name one thing." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add section" }));
    fireEvent.change(section(1).getByLabelText("Heading"), {
      target: { value: "What to change" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save template" }));

    expect(mutation("templates:create")).toHaveBeenCalledWith({
      name: "Retro",
      sections: [
        { guidance: "Name one thing.", heading: "What went well" },
        { heading: "What to change" },
      ],
    });
    await waitFor(() =>
      expect(screen.queryByLabelText("Template name")).not.toBeInTheDocument()
    );
  });

  it("edits an existing template", async () => {
    renderAt("/templates");
    fireEvent.click(
      await screen.findByRole("button", { name: "Edit Design review" })
    );

    expect(screen.getByLabelText("Template name")).toHaveValue("Design review");
    expect(section(1).getByLabelText("Guidance")).toHaveValue(
      "What could go wrong?"
    );
    fireEvent.click(section(0).getByRole("button", { name: "Remove section" }));
    fireEvent.click(screen.getByRole("button", { name: "Save template" }));

    expect(mutation("templates:update")).toHaveBeenCalledWith({
      name: "Design review",
      sections: [{ guidance: "What could go wrong?", heading: "Risks" }],
      templateId: "tpl1",
    });
  });

  it("blocks saving a template with an empty heading", async () => {
    renderAt("/templates");
    fireEvent.click(
      await screen.findByRole("button", { name: "New template" })
    );

    fireEvent.change(screen.getByLabelText("Template name"), {
      target: { value: "Retro" },
    });
    fireEvent.change(section(0).getByLabelText("Heading"), {
      target: { value: "   " },
    });

    expect(
      screen.getByText("Every section needs a heading.")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Save template" })
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save template" }));
    expect(mutation("templates:create")).not.toHaveBeenCalled();
  });

  it("deletes a template after confirming", async () => {
    renderAt("/templates");
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete Design review" })
    );
    expect(mutation("templates:remove")).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(mutation("templates:remove")).toHaveBeenCalledWith({
      templateId: "tpl1",
    });
  });
});
