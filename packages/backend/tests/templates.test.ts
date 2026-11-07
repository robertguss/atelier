import { register as registerWorkflow } from "@convex-dev/workflow/test";
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { beforeEach, afterEach, expect, vi, it, describe } from "vitest";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import {
  insertBlock,
  openChangeSet,
  orderBetween,
  patchBlock,
} from "../convex/lib/document";
import schema from "../convex/schema";
import { defined, rejectionsOf } from "./support";

const modules = import.meta.glob("../convex/**/*.ts");

const SECTIONS = [
  {
    guidance: "What are we trying to change, and for whom?",
    heading: "Goal",
  },
  { heading: "Risks" },
  { guidance: "Who does what by when.", heading: "Next steps" },
];

const setup = async () => {
  const t = convexTest(schema, modules);
  registerWorkflow(t);
  const owner = t.withIdentity({
    email: "owner@example.com",
    name: "Robert",
    subject: "owner",
  });
  const dana = t.withIdentity({
    email: "dana@example.com",
    name: "Dana",
    subject: "dana",
  });
  const runnerId = await t.mutation(api.runners.heartbeat, {
    harnesses: [{ id: "claude", version: "test" }],
    machine: "test",
    name: "test",
    secret: "test-secret",
  });
  return { dana, owner, runnerId, t };
};

const roomWithTeammate = async (
  s: Awaited<ReturnType<typeof setup>>,
  templateId?: Id<"templates">
) => {
  const roomId = await s.owner.mutation(api.rooms.create, {
    cwd: "/tmp/planning",
    name: "Planning",
    runnerId: s.runnerId,
    templateId,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => await Promise.resolve(Response.json([{ id: "user_1" }])))
  );
  const invite = await s.owner.action(api.invites.create, {
    email: "dana@example.com",
    roomId,
  });
  await s.dana.mutation(api.invites.accept, {
    token: defined(invite.url.split("/invite/")[1]),
  });
  vi.unstubAllGlobals();
  const { participants } = defined(
    await s.owner.query(api.rooms.get, { roomId })
  );
  return {
    claude: defined(participants.find((p) => p.harness === "claude")),
    danaParticipant: defined(
      participants.find((p) => p.displayName === "Dana")
    ),
    robert: defined(participants.find((p) => p.displayName === "Robert")),
    roomId,
  };
};

describe("templates", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.ATELIER_OWNER_EMAILS = "owner@example.com";
    process.env.ATELIER_RUNNER_SECRET = "test-secret";
    process.env.CLERK_SECRET_KEY = "sk_test";
    process.env.ATELIER_WEB_URL = "https://atelier.example.com/";
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("the owner creates, lists, updates and removes templates, and a removed template cannot seed a room", async () => {
    const { owner, runnerId } = await setup();
    const lists: unknown[] = [];
    const listed = async () => {
      const templates = await owner.query(api.templates.list, {});
      lists.push(templates.map((x) => [x._id, x.name, x.sections]));
    };
    await listed();
    const templateId = await owner.mutation(api.templates.create, {
      name: "  Discovery  ",
      sections: [{ guidance: "  ", heading: " Goal " }],
    });
    await listed();

    await owner.mutation(api.templates.update, {
      name: "Discovery v2",
      sections: SECTIONS,
      templateId,
    });
    await listed();
    const refused = await rejectionsOf([
      async () =>
        await owner.mutation(api.templates.update, {
          name: " ",
          sections: SECTIONS,
          templateId,
        }),
      async () =>
        await owner.mutation(api.templates.create, {
          name: "Blank heading",
          sections: [{ heading: "  " }],
        }),
    ]);

    await owner.mutation(api.templates.remove, { templateId });
    await listed();
    const late = await rejectionsOf([
      async () =>
        await owner.mutation(api.rooms.create, {
          cwd: "/tmp/late",
          name: "Late",
          runnerId,
          templateId,
        }),
    ]);
    expect({
      late: late.map((message) => message.includes("Unknown template")),
      lists,
      refused: [
        refused[0]?.includes("needs a name"),
        refused[1]?.includes("heading"),
      ],
    }).toStrictEqual({
      late: [true],
      lists: [
        [],
        [[templateId, "Discovery", [{ heading: "Goal" }]]],
        [[templateId, "Discovery v2", SECTIONS]],
        [],
      ],
      refused: [true, true],
    });
  });

  it("a teammate calling any template function is refused because only the owner can manage templates", async () => {
    const s = await setup();
    const templateId = await s.owner.mutation(api.templates.create, {
      name: "Discovery",
      sections: SECTIONS,
    });
    const { roomId } = await roomWithTeammate(s);
    const refusal = "Only the owner can manage templates";
    const refusals = await rejectionsOf([
      async () => await s.dana.query(api.templates.list, {}),
      async () =>
        await s.dana.mutation(api.templates.create, {
          name: "Mine",
          sections: SECTIONS,
        }),
      async () =>
        await s.dana.mutation(api.templates.update, {
          name: "Taken",
          sections: [],
          templateId,
        }),
      async () => await s.dana.mutation(api.templates.remove, { templateId }),
      async () =>
        await s.dana.mutation(api.templates.saveFromRoom, {
          name: "Copied",
          roomId,
        }),
    ]);
    const awaited5 = await s.owner.query(api.templates.list, {});
    expect({
      refusals: refusals.map((message) => message.includes(refusal)),
      templates: awaited5.map((x) => [x.name, x.sections]),
    }).toStrictEqual({
      refusals: [true, true, true, true, true],
      templates: [["Discovery", SECTIONS]],
    });
  });

  it("creating a room with a chosen template seeds its headings and guidance in order, attributed to Robert, in one change set", async () => {
    const s = await setup();
    const templateId = await s.owner.mutation(api.templates.create, {
      name: "Discovery",
      sections: SECTIONS,
    });
    const { roomId, robert } = await roomWithTeammate(s, templateId);
    const robertAuthor = { kind: "participant", participantId: robert._id };
    const doc = defined(await s.dana.query(api.documents.get, { roomId }));
    expect(doc.blocks.map((b) => [b.kind, b.text, b.author])).toStrictEqual([
      ["heading", "Goal", robertAuthor],
      [
        "paragraph",
        "What are we trying to change, and for whom?",
        robertAuthor,
      ],
      ["heading", "Risks", robertAuthor],
      ["heading", "Next steps", robertAuthor],
      ["paragraph", "Who does what by when.", robertAuthor],
    ]);
    await s.t.run(async (ctx) => {
      const awaited4 = await ctx.db.query("documents").collect();
      expect(awaited4.map((d) => d.templateId)).toStrictEqual([templateId]);
      const awaited3 = await ctx.db.query("changeSets").collect();
      expect(awaited3.map((c) => [c.kind, c.revisionCount])).toStrictEqual([
        ["template_seed", 5],
      ]);
      const awaited2 = await ctx.db.query("ledger").collect();
      const changed = awaited2.filter((e) => e.type === "document.changed");
      expect(changed).toHaveLength(1);
      expect(JSON.stringify(changed)).not.toContain("Who does what");
    });
  });

  it("saving a room as a template copies its headings and template guidance, but no paragraph a model or person wrote", async () => {
    const s = await setup();
    const templateId = await s.owner.mutation(api.templates.create, {
      name: "Discovery",
      sections: SECTIONS,
    });
    const { roomId, robert, danaParticipant, claude } = await roomWithTeammate(
      s,
      templateId
    );
    const doc = defined(await s.owner.query(api.documents.get, { roomId }));
    const [goal, goalGuidance, risks, nextSteps, nextGuidance] = doc.blocks;

    await s.t.run(async (ctx) => {
      const model = await openChangeSet(ctx, doc.documentId, {
        actorParticipantId: claude._id,
        kind: "model_turn",
      });
      await insertBlock(ctx, model, {
        author: { kind: "participant", participantId: claude._id },
        kind: "paragraph",
        order: orderBetween(defined(goalGuidance).order, defined(risks).order),
        text: "MODEL-FINDING the cache is cold",
      });
      await insertBlock(ctx, model, {
        author: { kind: "participant", participantId: claude._id },
        kind: "listItem",
        order: orderBetween(defined(risks).order, defined(nextSteps).order),
        text: "MODEL-RISK migrations",
      });
      const person = await openChangeSet(ctx, doc.documentId, {
        actorParticipantId: danaParticipant._id,
        kind: "human_edit",
      });
      const decisions = orderBetween(defined(nextGuidance).order, null);
      await insertBlock(ctx, person, {
        author: { kind: "participant", participantId: danaParticipant._id },
        kind: "heading",
        order: decisions,
        text: "Decisions",
      });
      await insertBlock(ctx, person, {
        author: { kind: "participant", participantId: danaParticipant._id },
        kind: "paragraph",
        order: orderBetween(decisions, null),
        text: "PERSON-NOTE we chose Postgres",
      });
      // Guidance someone has rewritten is now room content.
      await patchBlock(ctx, person, defined(nextGuidance)._id, {
        text: "PERSON-EDIT Dana does the rollout on Friday",
      });
    });
    expect(defined(goal).author).toStrictEqual({
      kind: "participant",
      participantId: robert._id,
    });

    const savedId = await s.owner.mutation(api.templates.saveFromRoom, {
      name: "  From planning  ",
      roomId,
    });
    const awaited = await s.owner.query(api.templates.list, {});
    const saved = defined(awaited.find((x) => x._id === savedId));
    expect(saved.name).toBe("From planning");
    expect(saved.sections).toStrictEqual([
      {
        guidance: "What are we trying to change, and for whom?",
        heading: "Goal",
      },
      { heading: "Risks" },
      { heading: "Next steps" },
      { heading: "Decisions" },
    ]);
    expect(JSON.stringify(saved)).not.toMatch(/MODEL-|PERSON-/u);
  });
});
